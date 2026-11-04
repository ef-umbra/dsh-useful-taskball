import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostContext, HostSessionEvent } from '../types.js'
import {
  Config,
  DEFAULT_BUBBLE_DURATION_MS,
  DEFAULT_COMPLETION_RETENTION_MINUTES,
  defaultConfig,
  type TaskballConfig,
} from './config.js'
import {
  applyFold,
  applyTurnEnd,
  applyTurnStart,
  pruneDocument,
  readDocument,
  writeDocument,
  type StoreDocument,
  type TurnEndRecord,
} from './store.js'
import { createReplayRunner, describeTurnEnd, type ReplaySource } from './replay.js'

export const name = 'dsh-useful-taskball'
export const inject: string[] = []
export { Config, DEFAULT_BUBBLE_DURATION_MS, DEFAULT_COMPLETION_RETENTION_MINUTES }
export { emptyDocument, parseDocument, serializeDocument } from './store.js'
export { applyFold, applyTurnEnd, applyTurnStart, pruneDocument } from './store.js'
export { createReplayRunner, describeTurnEnd, foldSessionEvents, replayOnce } from './replay.js'
export type { SessionRecord, StoreDocument, TurnEndRecord } from './store.js'
export type { ReplayEvent, ReplaySource } from './replay.js'

const STORAGE_FILE = 'dsh-useful-taskball.json'
/** The Web carrier's API prefix; exact Fetch routes must live under it. */
const API_PATH = '/api'
/** Keeps our two routes out of the gateway's `<namespace>/<method>` space. */
const ENDPOINT_PREFIX = 'taskball'
/** How often replay re-reads the corpus. Stored logs change slowly. */
const REPLAY_INTERVAL_MS = 5 * 60_000

/** Resolve the harness home without depending on the optional path service. */
function storageFile(ctx: HostContext): string {
  const resolve = ctx.get('dshHomePath')
  const base = typeof resolve === 'function'
    ? (resolve as (...segments: string[]) => string)('storages')
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages')
  return join(base, STORAGE_FILE)
}

export function apply(ctx: HostContext, config: TaskballConfig = defaultConfig()): void {
  const retentionMs = (): number => {
    const minutes = config.completionRetentionMinutes.get()
    return (typeof minutes === 'number' ? minutes : DEFAULT_COMPLETION_RETENTION_MINUTES) * 60_000
  }
  const file = storageFile(ctx)
  const document: StoreDocument = readDocument(file)

  // Coalesced flush: a turn emits several events in a row and every one of them
  // is a full-document rewrite otherwise.
  let scheduled = false
  let dirty = false
  const flush = (): void => {
    scheduled = false
    if (!dirty) return
    dirty = false
    if (!writeDocument(file, document)) {
      ctx.logger?.warn?.(`${name}: taskball state not written`)
    }
  }
  const touch = (): void => {
    dirty = true
    if (scheduled) return
    scheduled = true
    setTimeout(flush, 200)
  }

  ctx.effect(() => {
    pruneDocument(document, Date.now(), retentionMs())
    // `global: true` is load-bearing. `session/event` is scope-filtered
    // (dsh-scope): a listener without it only receives sessions entered through
    // its own agent context. This plugin has no agent context at all, so without
    // the flag it saw just one session while 14 were active across 6 workspaces
    // — and red is the whole reason this plugin has a Server half.
    const dispose = ctx.on('session/event', (session, event: HostSessionEvent) => {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (event.type === 'turn/start') {
        // No red is derived from this; the Client suppresses red while a session
        // runs, so re-entering a task needs no record surgery here.
        if (applyTurnStart(document, sessionId, event.time)) touch()
        return
      }
      if (event.type !== 'turn/end') return
      const end = describeTurnEnd(event.data, event.time)
      if (end === undefined) return
      if (applyTurnEnd(document, sessionId, end)) touch()
    }, { global: true })
    return () => {
      dispose()
      flush()
    }
  }, 'taskball: session events')

  /**
   * Cold-start replay for the `turn/end` facts the live subscription cannot see.
   *
   * `interrupted` is never emitted live (dsh-session: "The loop never emits this
   * marker live"); it is synthesized afterwards by agent-loop resume and by
   * `sessionQuery`'s cold read. Without replay, a session whose writer crashed
   * mid-turn stays invisible here and never turns red.
   *
   * `sessionQuery` is fetched with `ctx.get`, NOT declared in `inject`: it is
   * optional, and a missing service in `inject` makes cordis throw and the whole
   * loader entry go inactive (AGENTS.md §6.7 / §13). Absent service means replay
   * simply never runs and behaviour is exactly what it was before.
   *
   * The pass is asynchronous and never awaited: startup must not wait on a
   * 148 MB corpus read, and a replay failure must not prevent the plugin from
   * loading. The runner is coalesced so a slow pass cannot stack up.
   */
  ctx.effect(() => {
    const source = ctx.get('sessionQuery') as ReplaySource | undefined
    if (source === undefined || typeof source.readSession !== 'function') return
    const run = createReplayRunner({ document, logger: ctx.logger, source, touch })
    void run()
    const timer = setInterval(() => { void run() }, REPLAY_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      flush()
    }
  }, 'taskball: cold replay')

  // `connection.fetch.register` adds an EXACT route to the service's own
  // `fetchRoutes` table. That table is separate from the single `/api`
  // interceptor slot, which belongs to `dsh-api-gateway` and must never be
  // touched by a plugin: registering there throws when the gateway got there
  // first, and when the plugin wins the race the gateway's own registration
  // throws inside a child fiber with no log — every built-in Remote endpoint
  // then answers 404. Measured on this machine, that broke the entire Web UI.
  //
  // `rpc.handle` is also unusable: it registers via
  // `owner.effect(() => owner.webServer.register(...))` where `owner` is the
  // CONNECTION service's context (`inject = ["credentials"]`), so reading
  // `owner.webServer` throws and — because `effect()` only enqueues — `handle()`
  // still returns a disposer while the route never exists.
  ctx.inject(['connection'], (scoped: HostContext) => {
    const connection = scoped.get('connection') as {
      fetch: {
        register(route: {
          readonly path: string
          readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
          readonly requestBody: 'buffered' | 'streaming'
          readonly fetch: (request: Request) => Promise<Response>
        }): () => Promise<void>
      }
    } | undefined
    if (connection === undefined) return

    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    const stateRoute = connection.fetch.register({
      path: `${API_PATH}/${ENDPOINT_PREFIX}/state`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => json(200, {
        ok: true,
        value: { retentionMs: retentionMs(), sessions: document.sessions },
      }),
    })

    const foldRoute = connection.fetch.register({
      path: `${API_PATH}/${ENDPOINT_PREFIX}/fold`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload: { sessionId?: unknown; color?: unknown; folded?: unknown } | undefined
        try {
          payload = await request.json() as typeof payload
        } catch {
          return json(400, { ok: false, error: { code: 'bad-request', message: 'body is not JSON', details: {} } })
        }
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          return json(400, { ok: false, error: { code: 'bad-request', message: 'sessionId required', details: {} } })
        }
        const folded = payload?.folded === true
        const color = typeof payload?.color === 'string' ? payload.color : undefined
        if (applyFold(document, sessionId, folded ? Date.now() : undefined, folded ? color : undefined)) {
          touch()
        }
        return json(200, { ok: true, value: { foldedAt: document.sessions[sessionId]?.foldedAt ?? null } })
      },
    })

    return () => {
      void stateRoute()
      void foldRoute()
    }
  })
}
