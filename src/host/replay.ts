import {
  applyTurnEnd,
  applyTurnStart,
  type StoreDocument,
  type TurnEndRecord,
} from './store.js'

/**
 * Cold-start recovery for `turn/end` facts the live subscription can never see.
 *
 * `session/event` only carries events a live Session appends. An
 * `interrupted` turn is not one of them: the loop never emits that marker
 * live. It is synthesized afterwards — agent-loop resume appends it for a
 * stored log whose tail turn never ended, and `sessionQuery`'s cold read
 * synthesizes it in memory (`nothing is written back`). So a session whose
 * writer crashed mid-turn stays invisible to this plugin until the process
 * reads the log back, and red is the whole reason this plugin has a Server
 * half. Replay closes that hole.
 *
 * The judgement is NOT re-implemented here. The Host already owns it as
 * `interruptedTurnClosers(events)` (dsh-session/repair), whose semantics are
 * heavier than "a turn/start has no matching turn/end": it also supplies the
 * missing `tool/result` events and the open `step/end`. `sessionQuery.readSession`
 * returns events that ALREADY include those closers, so this module only has to
 * fold the resulting `turn/end` records like any other. Re-deriving the marker
 * here would fork from the Host's judgement the first time it changes.
 */

/** One persisted session event, as the session-query service returns it. */
export interface ReplayEvent {
  readonly type: string
  /** Monotonic within the session; the cursor basis, because `time` repeats. */
  readonly seq?: number
  readonly time: number
  readonly data?: unknown
}

export interface ReplaySessionHeader {
  readonly id?: string
  /** Unix epoch ms, as `SessionHeader.createdAt`. */
  readonly createdAt?: number
  readonly origin?: string
}

/** One corpus record; `live` means the live subscription already covers it. */
export interface ReplaySessionRecord {
  readonly header: ReplaySessionHeader
  readonly live?: boolean
}

export interface ReplayLogSnapshot {
  readonly session: ReplaySessionHeader
  readonly events: readonly ReplayEvent[]
}

/**
 * The two reads this module needs from `sessionQuery`. Declared structurally so
 * the module stays testable without the real service and so the plugin does not
 * take a type dependency on a host package (AGENTS.md §8).
 */
export interface ReplaySource {
  listSessions(signal?: AbortSignal): Promise<readonly ReplaySessionRecord[]>
  readSession(sessionId: string): Promise<ReplayLogSnapshot>
}

interface TurnEndData {
  readonly turn?: number
  readonly reason?: {
    readonly kind?: string
    readonly reason?: { readonly kind?: string }
    readonly error?: { readonly message?: string }
  }
}

/** Flatten one `turn/end` reason into the durable shape; the Host does not judge it. */
export function describeTurnEnd(data: unknown, at: number): TurnEndRecord | undefined {
  const reason = (data as TurnEndData | undefined)?.reason
  const kind = reason?.kind
  if (typeof kind !== 'string') return undefined
  const cause = reason?.reason?.kind
  const message = reason?.error?.message
  if (typeof cause === 'string' && typeof message === 'string') return { kind, cause, message, at }
  if (typeof cause === 'string') return { kind, cause, at }
  if (typeof message === 'string') return { kind, message, at }
  return { kind, at }
}

/** Whether a record has anything replayable past its cursor. */
function cursorOf(document: StoreDocument, sessionId: string): number {
  return document.sessions[sessionId]?.replayedThroughSeq ?? -1
}

/**
 * Fold one session's persisted events into the document, oldest first.
 *
 * Replaying a session that the live subscription already recorded is safe:
 * `applyTurnEnd` is idempotent per identical ending (D-007), so the second pass
 * is a no-op rather than a duplicate red or a refreshed timestamp.
 *
 * Subagent sessions are deliberately NOT filtered here. The live path records
 * them too, and `origin` filtering is a presentation decision owned by the
 * Client's `deriveView` (AGENTS.md §6.11). Filtering in a second place is
 * exactly the double-owner defect B-006.
 *
 * @returns the highest seq consumed, or `undefined` when nothing was consumed.
 */
export function foldSessionEvents(
  document: StoreDocument,
  sessionId: string,
  events: readonly ReplayEvent[],
  throughSeq: number,
): number | undefined {
  let highest: number | undefined
  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    // `seq` is monotonic per session; `time` is not a usable cursor because a
    // synthetic closer reuses the last real event's timestamp (repair.d.ts).
    if (seq !== undefined && seq <= throughSeq) continue
    if (seq !== undefined && (highest === undefined || seq > highest)) highest = seq
    if (event.type === 'turn/start') {
      applyTurnStart(document, sessionId, event.time)
      continue
    }
    if (event.type !== 'turn/end') continue
    const end = describeTurnEnd(event.data, event.time)
    if (end !== undefined) applyTurnEnd(document, sessionId, end)
  }
  return highest
}

export interface ReplayDeps {
  readonly document: StoreDocument
  readonly source: ReplaySource
  /** Marks the document dirty so the coalesced writer flushes it. */
  readonly touch: () => void
  readonly logger?: { warn(message: string, error?: unknown): void }
  /** Injected for tests; defaults to `Date.now()`. */
  readonly now?: number
  /** Sessions already visited in this cycle; mutated by the pass. */
  readonly cycle?: Set<string>
  /** Sessions read this pass; defaults to `REPLAY_BUDGET_PER_PASS`. */
  readonly budget?: number
}

export interface ReplayResult {
  readonly inspected: number
  readonly changed: number
  readonly failed: number
}

/**
 * How far back a stored session is still worth replaying.
 *
 * Replay exists to surface a turn that crashed while the process was down. A
 * session untouched for a week is not that: its turn, if it ever was orphaned,
 * was closed by whichever resume ran next, and resurrecting it as a red would
 * report a failure nobody can act on. This bound is also what keeps the cost
 * finite — the corpus on this machine is 380 logs / 148 MB, and only the recent
 * tail of it can contain an unresolved turn.
 */
export const REPLAY_LOOKBACK_MS = 7 * 24 * 60 * 60_000

/**
 * Sessions read per pass.
 *
 * `readSession` decompresses the WHOLE log (a single file reaches 8.18 MB /
 * 15580 events here), so a pass over the entire corpus would be hundreds of
 * megabytes of decompression on the Host's main thread. The budget spreads one
 * full cycle over several passes instead, and each pass is cheap.
 */
export const REPLAY_BUDGET_PER_PASS = 40

/**
 * One replay pass over the corpus.
 *
 * Live sessions are skipped: the subscription already records them, and reading
 * every live log would spend the budget re-deriving facts already in hand.
 *
 * Cost is bounded three ways: the lookback window, the per-pass budget, and the
 * per-session seq cursor (a session that gained no events is not re-folded).
 * The budget rotates through a cycle set so coverage is complete over time
 * without any single pass doing all the work.
 *
 * A per-session failure is contained. Replay must never clear the document or
 * abort the pass: a session that cannot be read today may be readable tomorrow,
 * and dropping the rest would lose facts that are still valid.
 */
export async function replayOnce(deps: ReplayDeps): Promise<ReplayResult> {
  const { document, source, touch } = deps
  let inspected = 0
  let changed = 0
  let failed = 0

  let records: readonly ReplaySessionRecord[]
  try {
    records = await source.listSessions()
  } catch (error) {
    deps.logger?.warn('taskball: replay could not list sessions', error)
    return { inspected: 0, changed: 0, failed: 0 }
  }
  if (!Array.isArray(records)) return { inspected: 0, changed: 0, failed: 0 }

  const now = deps.now ?? Date.now()
  const cycle = deps.cycle
  const collect = (): { createdAt: number; id: string }[] => {
    const found: { createdAt: number; id: string }[] = []
    for (const record of records) {
      const sessionId = record?.header?.id
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (record.live === true) continue
      const createdAt = record.header.createdAt
      // A header without a timestamp cannot be placed in the window; treat it as
      // recent rather than silently dropping a possible orphan.
      if (typeof createdAt === 'number' && now - createdAt > REPLAY_LOOKBACK_MS) continue
      if (cycle !== undefined && cycle.has(sessionId)) continue
      found.push({ createdAt: typeof createdAt === 'number' ? createdAt : now, id: sessionId })
    }
    // Newest first: the most likely orphan is the session that was running when
    // the process died, and it should be surfaced on the first pass, not the last.
    found.sort((left, right) => right.createdAt - left.createdAt)
    return found
  }

  let candidates = collect()
  // A cycle that has visited every candidate starts over in the SAME pass.
  // Clearing it and returning instead would burn a whole interval doing nothing,
  // which after a restart is the pass that matters most.
  if (candidates.length === 0 && cycle !== undefined && cycle.size > 0) {
    cycle.clear()
    candidates = collect()
  }

  for (const candidate of candidates.slice(0, deps.budget ?? REPLAY_BUDGET_PER_PASS)) {
    const sessionId = candidate.id
    inspected += 1
    cycle?.add(sessionId)
    const throughSeq = cursorOf(document, sessionId)
    let snapshot: ReplayLogSnapshot
    try {
      snapshot = await source.readSession(sessionId)
    } catch {
      // Absent, corrupt or migration-required logs are expected states, not
      // incidents: the session simply keeps whatever the live path recorded.
      failed += 1
      continue
    }
    const events = snapshot?.events
    if (!Array.isArray(events)) continue
    const highest = foldSessionEvents(document, sessionId, events, throughSeq)
    if (highest === undefined) continue
    const existing = document.sessions[sessionId]
    if (existing !== undefined && highest > (existing.replayedThroughSeq ?? -1)) {
      existing.replayedThroughSeq = highest
      changed += 1
      touch()
    }
  }

  return { inspected, changed, failed }
}

/**
 * Coalesce passes and keep the rotation state.
 *
 * The cycle set is what makes a bounded pass cover the whole corpus: once every
 * candidate in the window has been visited, the set empties and the next pass
 * starts over with fresh cursors. It is in-memory only — after a restart the
 * first pass simply re-reads the newest sessions, which is exactly what a cold
 * start needs.
 */
export function createReplayRunner(deps: ReplayDeps): () => Promise<ReplayResult | undefined> {
  let running = false
  let cycle = new Set<string>()
  return async () => {
    if (running) return undefined
    running = true
    try {
      return await replayOnce({ ...deps, cycle })
    } finally {
      running = false
    }
  }
}
