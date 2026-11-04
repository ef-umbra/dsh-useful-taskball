import * as React from 'react'
import { EMPTY_HOST_STATE, type HostState, type TaskballColor } from './model.js'

/**
 * Exact Fetch routes on the Host's `/api` prefix.
 *
 * These are NOT RPC channel calls. A plugin cannot use either RPC entry:
 *
 * - `rpc.intercept('/api', …)` takes the single interceptor slot that belongs to
 *   `dsh-api-gateway`. Whoever registers second throws; when the plugin wins,
 *   the gateway's registration fails inside a child fiber with no log and every
 *   built-in Remote endpoint answers 404 — the whole Web UI breaks.
 * - `rpc.handle(channel, …)` registers through `owner.webServer` on the
 *   CONNECTION service's own context (`inject = ["credentials"]`), so the
 *   registration effect throws and the route never exists.
 *
 * `connection.fetch.register` uses a separate `fetchRoutes` table, still behind
 * the `/api` auth and Host/Origin fence, and composes with the gateway.
 */
export const API_PATH = '/api'
export const ENDPOINT_PREFIX = 'taskball'

export interface HostReply<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

/** Same-origin, so the browser session cookie rides along automatically. */
async function post<T>(endpoint: string, body: unknown): Promise<HostReply<T> | undefined> {
  try {
    const response = await globalThis.fetch(`${API_PATH}/${ENDPOINT_PREFIX}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return undefined
    return await response.json() as HostReply<T>
  } catch {
    return undefined
  }
}

/** How often the Client re-reads Host state; the Host also pushes nothing. */
const POLL_MS = 5000
/** Expiry is minute-grained, so a coarse tick keeps the ball honest cheaply. */
const TICK_MS = 15_000
/**
 * How long the plugin may keep saying "still loading" when the Host route never
 * answers.
 *
 * Readiness gates the wording only, so an unreachable Host must not turn into a
 * forever-spinning ball: after two poll intervals the plugin shows what it can
 * derive instead. Two intervals is the smallest bound that still survives one
 * lost response, and it keeps the state honest — a broken route is visible as a
 * missing red/green, not as "loading" for eternity.
 */
export const HOST_READY_GRACE_MS = 2 * POLL_MS

/** The Host view plus whether at least one read has landed (D-033). */
export interface HostStateResult {
  readonly state: HostState
  readonly ready: boolean
}

function readState(reply: HostReply<unknown> | undefined): HostState | undefined {
  if (reply?.ok !== true) return undefined
  const value = reply.value as { retentionMs?: unknown; sessions?: unknown } | undefined
  if (value === undefined || typeof value.retentionMs !== 'number') return undefined
  if (typeof value.sessions !== 'object' || value.sessions === null) return undefined
  return { retentionMs: value.retentionMs, sessions: value.sessions as HostState['sessions'] }
}

/**
 * Host state is the only source of red, of completion times and of fold
 * records, so a failed read must degrade to "no red, nothing folded" rather
 * than to a stale guess: the ball would otherwise keep showing a failure the
 * Host no longer reports.
 *
 * `ready` says whether the FIRST read has landed. It is what separates "the
 * Host reported no sessions" from "the Host has not reported yet": the ball
 * used to render the empty fallback as if it were an answer, so every page
 * reload claimed "no task states" while the client itself was still booting
 * (measured 0.6–6.5s of false empty, D-033). A grace timer keeps a broken
 * route from claiming "loading" forever.
 */
export function useHostState(): HostStateResult {
  const [state, setState] = React.useState<HostState>(EMPTY_HOST_STATE)
  const [ready, setReady] = React.useState(false)
  const sequence = React.useRef(0)

  React.useEffect(() => {
    let disposed = false
    let inFlight = false
    const load = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      const ticket = ++sequence.current
      try {
        const reply = await post<unknown>('state', {})
        if (disposed || ticket !== sequence.current) return
        const next = readState(reply)
        if (next !== undefined) {
          setState(next)
          setReady(true)
        }
      } finally {
        inFlight = false
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    const grace = setTimeout(() => { setReady(true) }, HOST_READY_GRACE_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(grace)
    }
  }, [])

  return { state, ready }
}

/**
 * The current time, re-read on every render, with a coarse tick to force one.
 *
 * The interval is a RE-RENDER trigger only — it must not be the source of the
 * returned value. This used to return the timestamp captured by the last tick,
 * which is stale by up to a full interval (15 s here) on every render in
 * between. That is harmless for retention expiry, whose resolution is minutes,
 * but it silently broke the in-flight witness window: witnesses are stamped and
 * judged with THIS number, so a 10 s window judged by a 15 s-stale clock stops
 * measuring elapsed time and only ever means "stamped during the current tick".
 * Every tick then discarded witnesses that were still valid, repainting a
 * finishing session GRAY (measured 2026-10-30: ~19% of turn endings, 0.1–5.1 s).
 *
 * Returning `Date.now()` here fixes it at the source: the stamp and the
 * judgement cannot come from two different clocks, because there is only one.
 * Judging with a finer clock while stamping with a coarse one would make
 * `now - witness` negative and hold blue far too long, so both must change
 * together (the A/B measurement in `test/state-machine.test.mjs` pins this).
 */
export function useNow(intervalMs: number = TICK_MS): number {
  const [, forceTick] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => { forceTick((count) => count + 1) }, intervalMs)
    return () => { clearInterval(timer) }
  }, [intervalMs])
  return Date.now()
}

export interface HostStateWriter {
  fold(sessionId: string, color: TaskballColor, folded: boolean): Promise<void>
}

export function createHostWriter(): HostStateWriter {
  return {
    async fold(sessionId, color, folded) {
      await post('fold', { sessionId, color, folded })
    },
  }
}
