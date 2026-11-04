export type TaskballColor = 'red' | 'yellow' | 'blue' | 'green' | 'gray'

/**
 * No session has a draft.
 *
 * Declared here, not in `drafts.ts`, because this module is the pure state
 * machine and must not import a React module (AGENTS §7: `model.ts` compiles
 * standalone into `lib/model.mjs` for the tests). `drafts.ts` re-exports it so
 * the read path and the derivation share one constant.
 */
export const NO_DRAFT_IDS: ReadonlySet<string> = new Set()

/**
 * Status order, used for the ring's sector order AND the collapsed strip's
 * segment order (F-021 / D-063).
 *
 * It began as a priority ranking that nothing referenced — the ring painted in
 * session order, the panel grouped by workspace. The collapsed strip is one
 * vertical bar where the order IS the reading: a user looking at five stacked
 * segments needs "worst first" to mean something. Giving the strip its own sort
 * would be a second owner for one fact, so the ranking is promoted to the single
 * display order both surfaces use — the bar and the ring can then never disagree
 * about which status comes first.
 */
export const COLOR_ORDER: readonly TaskballColor[] = ['red', 'yellow', 'blue', 'green']

export interface TaskballStatus {
  readonly running: boolean | undefined
  readonly pendingInteraction: { readonly kind: string } | undefined
  readonly completionUnread: boolean
}

export interface TaskballSession {
  readonly id: string
  readonly title: string
  readonly displayTitle: string
  readonly blank: boolean
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly updatedAt: number
}

export interface TaskballWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

export interface TaskballEntry {
  readonly id: string
  readonly title: string
  readonly color: TaskballColor
  readonly workspaceId: string | undefined
  readonly updatedAt: number
  readonly completedAt: number | undefined
}

/** One `turn/end` as the Host recorded it; the Host does not classify it. */
export interface HostTurnEnd {
  readonly kind: string
  readonly cause?: string
  readonly message?: string
  readonly at: number
}

export interface HostSessionRecord {
  readonly turnStartAt?: number
  readonly lastTurnEnd?: HostTurnEnd
  /** Every `turn/end` since the most recent `completed`, oldest first. */
  readonly endsSinceCompletion?: readonly HostTurnEnd[]
  readonly foldedAt?: number
  readonly foldedColor?: string
}

/** The Host's view of the world, as returned by the `state` endpoint. */
export interface HostState {
  readonly retentionMs: number
  readonly sessions: Readonly<Record<string, HostSessionRecord>>
}

/**
 * The workspace registry's global archive set plus the real workspaces.
 *
 * Archiving is the user's explicit "I am done with this" action, so D-005 makes
 * it an exit for red: an archived session must stop occupying the ring even
 * though its stored failure stays inspectable in the panel. The set lives on the
 * workspace snapshot (`archivedSessionIds`), not on the Host session record, so
 * it has to be threaded through the derivation explicitly.
 */
export interface ArchiveState {
  readonly archivedSessionIds: ReadonlySet<string>
}

export const NO_ARCHIVE_STATE: ArchiveState = { archivedSessionIds: new Set() }

export const EMPTY_HOST_STATE: HostState = { retentionMs: 30 * 60_000, sessions: {} }

/**
 * How soon after a failure a restart still counts as the loop retrying by
 * itself rather than the user re-entering the task.
 *
 * Measured over 117 real failure→restart pairs on this machine: the four that
 * carried no user message at all restarted after 231–420 ms, while every
 * user-initiated restart was either ≥ 2.4 s or came from a resume prompt
 * another agent injected. One second sits above the automatic band and well
 * below the user band, so it separates the two without guessing.
 */
export const AUTO_CONTINUATION_MS = 1000

/**
 * The live signal, in the same terms `failureOf` needs it.
 *
 * `running` is event-driven (the frame a turn ends, it flips false), while the
 * Host's `turnStartAt` only arrives on the next 5s poll. Without this, a user
 * who re-enters a failed session keeps seeing it RED for up to one poll
 * interval — measured 2026-10-30: 0–4999ms, median ~2.5s, with the reply already
 * streaming in the conversation. `now` is the real clock, so the same
 * `AUTO_CONTINUATION_MS` band can be applied to the failure's own timestamp.
 */
export interface LiveSignal {
  readonly running: boolean
  readonly now: number
}

/**
 * Red is an unresolved failure of the CURRENT attempt.
 *
 * A restart cancels it, but only once the user is actually driving again. The
 * loop also re-enters a failed session on its own within a few hundred
 * milliseconds; those retries end `aborted` by the user cause (measured: 4 of
 * 4), which is not a failure, so treating them as recovery made red vanish
 * within one frame and the ball never showed a failure at all.
 *
 * "Has a new turn started since this failure?" has TWO witnesses, and each
 * covers the other's blind spot:
 *
 * - the Host's `turnStartAt`, authoritative but up to 5s late;
 * - the live `running` flag, immediate but ambiguous on its own — the automatic
 *   retry also flips it true a few hundred ms after the failure.
 *
 * The `AUTO_CONTINUATION_MS` band is what resolves the ambiguity, and it is
 * applied to BOTH witnesses identically: a restart (or a running turn observed)
 * at least one second after the failure is the user re-entering, anything sooner
 * is the loop retrying by itself. Re-measured over the real corpus 2026-10-30
 * (391 logs / 1544 turns / 120 failure→restart pairs): every automatic retry
 * sat at 231–420 ms and NOT ONE had a gap ≥ 1000 ms, so the band still holds —
 * it is now simply usable without waiting for the poll.
 */
export function failureOf(
  record: HostSessionRecord | undefined,
  live?: LiveSignal,
): string | undefined {
  /**
   * Whether the failure at `at` has been left behind by a new attempt.
   *
   * Host evidence and live evidence are the SAME claim ("a turn started later
   * than the automatic band"), which is why they share one threshold: using a
   * different band for each would make the two sources disagree during the
   * window where both are present.
   */
  const reenteredSince = (at: number): boolean => {
    const restartAt = record?.turnStartAt
    if (restartAt !== undefined && restartAt - at >= AUTO_CONTINUATION_MS) return true
    return live?.running === true && live.now - at >= AUTO_CONTINUATION_MS
  }
  const tail = record?.endsSinceCompletion
  if (tail !== undefined && tail.length > 0) {
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const end = tail[index]
      if (end === undefined) continue
      if (!isFailureKind(end.kind, end.cause)) continue
      if (reenteredSince(end.at)) return undefined
      return end.message !== undefined && end.message !== '' ? end.message : end.kind
    }
    return undefined
  }
  const end = record?.lastTurnEnd
  if (end === undefined || !isFailureKind(end.kind, end.cause)) return undefined
  if (reenteredSince(end.at)) return undefined
  if (end.message !== undefined && end.message !== '') return end.message
  return end.kind
}

/** Completion time only counts when the last turn actually completed. */
export function completedAtOf(record: HostSessionRecord | undefined): number | undefined {
  const end = record?.lastTurnEnd
  if (end === undefined || end.kind !== 'completed') return undefined
  return end.at
}

/**
 * The live status snapshot the ball is currently deriving from.
 *
 * Needed because "the Host started a turn and never recorded its end" is a
 * PERMANENT state for stale records, not only a 5s window: measured 2026-10-30,
 * 7 of 48 stored sessions sat in that state for 1.9–6.7 DAYS (a plugin restart
 * during a turn loses its `turn/end`). Without a second witness those sessions
 * read as "running" forever — which is exactly the false-blue regression
 * reported right after the first version of this fix.
 */
export interface FlightWitness {
  /** The Client watched this session running at some point in this page's life. */
  readonly sawRunning: boolean
  /** When it last saw `running === true`, in `Date.now()` terms. */
  readonly runningSince: number | undefined
}

/** Sessions the Client has personally watched running, with timestamps. */
export type FlightWitnesses = ReadonlyMap<string, number>

/** No session has been watched running yet. */
export const EMPTY_WITNESSES: FlightWitnesses = new Map()

/**
 * The Host-state poll interval, duplicated here because the derivation needs the
 * same number to size its witness window and must not import the poller (that
 * would make the pure state machine depend on a React module).
 */
export const DEFAULT_POLL_MS = 5000

/**
 * How long after the Client last watched a session running may "the Host never
 * recorded an end" still mean in-flight?
 *
 * Two poll intervals: one response may still be in flight when the turn ends, so
 * a single interval cannot separate "not applied yet" from "never coming". A
 * genuinely running turn keeps refreshing the witness every status update, so
 * this bound only ever expires sessions that STOPPED — stale records included.
 */
export function flightWindowMs(pollMs: number): number {
  return pollMs * 2
}

/**
 * Whether this session should still be painted blue because a turn is in flight.
 *
 * The two inputs behind a colour have very different latencies: `SessionStatus`
 * is event-driven (a turn ending flips `running` to false within a frame), while
 * the Host's `turn/end` record only reaches the Client on the next 5s poll. In
 * that gap the live status says "nothing is happening" and the Host has no
 * completion time yet, so the plain derivation reported GRAY — the session
 * flashed gray for up to a poll interval before turning green (2026-10-30), and
 * the flash SPLIT the edge into blue→gray→green so the completion bubble could
 * never fire.
 *
 * Both conditions are required, and each rules out the other's failure mode:
 *
 * - `turnInFlight(record)` — the Host has an unfinished turn. Necessary: a plain
 *   time-since-running rule would resurrect blue for sessions that ended while
 *   the page was closed.
 * - `witness` — the Client watched this exact session running within the last
 *   `windowMs`. Necessary: an unfinished Host turn is permanent for records whose
 *   end was lost (7 of 48 here, up to 6.7 days old). Without it they read blue
 *   forever, which is the false-blue regression of 2026-10-30.
 *
 * Do NOT relax either half into a guess: guessing an end by time is what
 * D-032/B-008 were about, and guessing an in-flight turn by Host record alone is
 * what produced the false blues.
 */
export function turnInFlight(
  record: HostSessionRecord | undefined,
  witness: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  const startedAt = record?.turnStartAt
  if (startedAt === undefined) return false
  const lastEndAt = record?.lastTurnEnd?.at
  if (lastEndAt !== undefined && lastEndAt >= startedAt) return false
  if (witness === undefined) return false
  return now - witness <= windowMs
}

/**
 * Record "this session was seen running" so `turnInFlight` has a second witness.
 *
 * Returns the previous map unchanged when nothing is new, so the caller can keep
 * object identity (an ever-new map would re-render on every poll).
 */
export function noteRunning(witnesses: FlightWitnesses, running: readonly string[], now: number): FlightWitnesses {
  let next: Map<string, number> | undefined
  for (const id of running) {
    const previous = witnesses.get(id)
    // Refresh on every observation: the window must measure "still running", not
    // "started running once".
    if (previous !== undefined && now - previous < 1000) continue
    next = next ?? new Map(witnesses)
    next.set(id, now)
  }
  return next ?? witnesses
}

/** Drop witnesses that can no longer matter, so the map cannot grow forever. */
export function pruneWitnesses(witnesses: FlightWitnesses, now: number, windowMs: number): FlightWitnesses {
  let next: Map<string, number> | undefined
  for (const [id, at] of witnesses) {
    if (now - at <= windowMs) continue
    next = next ?? new Map(witnesses)
    next.delete(id)
  }
  return next ?? witnesses
}

/**
 * A fold is cancelled by any state change (DECISION.md D-006).
 *
 * Colour equality alone is NOT enough: blue → green (folded) → blue → green
 * comes back to the folded colour, so a colour-only test resurrects the fold and
 * the session silently lands in "handled" the moment it finishes again — its
 * blue sector vanished and never became green. Any turn activity newer than the
 * fold therefore cancels it, which covers the same-colour round trip.
 */
export function isFoldedNow(record: HostSessionRecord | undefined, color: TaskballColor): boolean {
  if (record?.foldedAt === undefined) return false
  if (record.foldedColor !== color) return false
  const foldedAt = record.foldedAt
  if (record.turnStartAt !== undefined && record.turnStartAt > foldedAt) return false
  const lastEndAt = record.lastTurnEnd?.at
  if (lastEndAt !== undefined && lastEndAt > foldedAt) return false
  return true
}

export function foldedIds(state: HostState, colors: ReadonlyMap<string, TaskballColor>): Set<string> {
  const folded = new Set<string>()
  for (const [sessionId, record] of Object.entries(state.sessions)) {
    const color = colors.get(sessionId)
    if (color === undefined) continue
    if (isFoldedNow(record, color)) folded.add(sessionId)
  }
  return folded
}

export const PENDING_INTERACTION_KINDS: readonly string[] = ['approval', 'plan-review', 'question']

export function classifyStatus(status: TaskballStatus | undefined, hasFailure: boolean): TaskballColor {
  if (hasFailure) return 'red'
  if (status?.pendingInteraction !== undefined
    && PENDING_INTERACTION_KINDS.includes(status.pendingInteraction.kind)) return 'yellow'
  if (status?.running === true) return 'blue'
  if (status?.completionUnread === true) return 'green'
  return 'gray'
}

/** One display title for a session, tolerant of a row the host has not titled. */
export function titleOf(session: {
  readonly title?: string | undefined
  readonly displayTitle?: string | undefined
  readonly id?: string | undefined
}): string {
  const title = typeof session.title === 'string' ? session.title.trim() : ''
  if (title !== '') return title
  const display = typeof session.displayTitle === 'string' ? session.displayTitle.trim() : ''
  if (display !== '') return display
  return typeof session.id === 'string' ? session.id : ''
}

/**
 * A green entry is expired once it has been completed longer than the
 * retention threshold. Red/yellow/blue never expire (DECISION.md D-004), and
 * a green whose completion time is unknown cannot be aged, so it stays.
 */
export function isGreenExpired(
  color: TaskballColor,
  completedAt: number | undefined,
  retentionMs: number,
  now: number,
): boolean {
  if (color !== 'green') return false
  return isExpired(completedAt, retentionMs, now)
}

export function isFailureKind(kind: string, cancelCause: string | undefined): boolean {
  if (kind === 'error' || kind === 'interrupted' || kind === 'blocked') return true
  if (kind !== 'aborted') return false
  return cancelCause !== undefined && cancelCause !== 'user' && cancelCause !== 'legacy'
}

/**
 * Sessions the panel and the ball may show.
 *
 * `blank` means the host folded a session whose prefix contains no turn yet —
 * a new conversation that has not been sent. Those never reach the ball, because
 * an empty conversation is not a task state (D-001/D-028).
 *
 * F-001 makes ONE exception: a blank session that HAS a draft is exactly the
 * thing the user asked to see. It is passed through and the caller decides what
 * to do with it — `deriveView` keeps it as a draft entry and gives it NO colour,
 * so it still never occupies a sector (user, 2026-10-31: option (a)).
 */
export function visibleSessions(
  sessions: readonly TaskballSession[],
  draftIds: ReadonlySet<string> = NO_DRAFT_IDS,
): TaskballSession[] {
  // Defensive on the row identity as well: a row without a usable id can take
  // down the whole overlay through the slot's error boundary, and the host's row
  // shape is not something this plugin controls.
  return sessions.filter((session) => typeof session?.id === 'string' && session.id !== ''
    && session.origin !== 'subagent'
    && (!session.blank || draftIds.has(session.id)))
}

export function groupByWorkspace(
  sessions: readonly TaskballSession[],
  workspaces: readonly TaskballWorkspace[],
): { key: string; label: string; sessions: TaskballSession[] }[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const groups: { key: string; label: string; sessions: TaskballSession[] }[] = []
  const grouped = new Set<string>()
  for (const workspace of workspaces) {
    if (!Array.isArray(workspace?.sessionIds)) continue
    const members = workspace.sessionIds
      .map((id) => byId.get(id))
      .filter((session): session is TaskballSession => session !== undefined)
    if (members.length === 0) continue
    for (const member of members) grouped.add(member.id)
    groups.push({ key: workspace.workspaceId, label: workspace.title, sessions: members })
  }
  const loose = sessions.filter((session) => !grouped.has(session.id))
  if (loose.length > 0) groups.push({ key: 'ungrouped', label: 'UNGROUPED', sessions: loose })
  return groups
}

export function countByColor(entries: readonly TaskballEntry[]): Record<TaskballColor, number> {
  const counts: Record<TaskballColor, number> = { red: 0, yellow: 0, blue: 0, green: 0, gray: 0 }
  for (const entry of entries) counts[entry.color] += 1
  return counts
}

/**
 * Order entries the way both the ring and the collapsed strip read them: worst
 * status first (`COLOR_ORDER`), then most recently updated, then id.
 *
 * The tie-breakers matter more than the status order in practice — several
 * sessions share a colour most of the time — and they must be DETERMINISTIC:
 * `TaskballEntry` objects arrive in session-store order, which changes whenever
 * the store rebuilds, so sorting on colour alone would let two same-colour
 * sectors swap places between renders and the ring would visibly jitter.
 */
export function orderEntries(entries: readonly TaskballEntry[]): TaskballEntry[] {
  const rank = (color: TaskballColor): number => {
    const index = COLOR_ORDER.indexOf(color)
    return index === -1 ? COLOR_ORDER.length : index
  }
  return [...entries].sort((left, right) => {
    const byColor = rank(left.color) - rank(right.color)
    if (byColor !== 0) return byColor
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * Ring sectors: equal slices in `orderEntries` order.
 *
 * Gray never occupies a sector, and the colours are folded into a sorted list
 * FIRST so the ring and the strip cannot disagree about which session comes
 * first (D-063). Callers pass the folded-active entries; this function does not
 * re-filter, because `occupiesSector` is the single owner of that rule.
 */
export function sectorAngles(entries: readonly TaskballEntry[]): { start: number; end: number; color: TaskballColor }[] {
  const visible = orderEntries(entries.filter((entry) => entry.color !== 'gray'))
  if (visible.length === 0) return []
  const step = 360 / visible.length
  return visible.map((entry, index) => ({
    start: index * step,
    end: (index + 1) * step,
    color: entry.color,
  }))
}

export function isExpired(
  completedAt: number | undefined,
  retentionMs: number,
  now: number,
): boolean {
  if (completedAt === undefined) return false
  return now - completedAt > retentionMs
}

/**
 * Whether an entry occupies a sector on the ball.
 *
 * The ball and the panel's active list must agree exactly (DECISION.md D-028),
 * so both call this one predicate instead of each spelling out an equivalent
 * rule. A folded entry is "handled" — the user said so explicitly — and stops
 * occupying the ring for EVERY colour. D-024 used to exempt blue on the theory
 * that hiding a running session loses the only "something is working" signal,
 * but that produced two disagreeing surfaces: the panel said handled while the
 * ball still showed it. The user rejected that on 2026-10-28.
 */
export function occupiesSector(
  color: TaskballColor,
  folded: ReadonlySet<string>,
  id: string,
): boolean {
  if (color === 'gray') return false
  return !folded.has(id)
}

export function sectorEntries(
  entries: readonly TaskballEntry[],
  folded: ReadonlySet<string>,
): TaskballEntry[] {
  return entries.filter((entry) => occupiesSector(entry.color, folded, entry.id))
}

export interface DerivedView {
  readonly entries: readonly TaskballEntry[]
  readonly folded: ReadonlySet<string>
  readonly failures: ReadonlyMap<string, string>
  /**
   * Sessions with unsent content, in the order the panel lists them (F-001).
   *
   * Deliberately NOT part of `entries`: a draft is not a task state, so it has no
   * colour, no sector, no fold state and no expiry. Keeping it in a separate list
   * is what makes "the ball shows only task states" a structural property rather
   * than something to keep remembering (user, 2026-10-31: option (a)).
   */
  readonly drafts: readonly DraftEntry[]
}

/** One session with unsent content, as the panel's draft section renders it. */
export interface DraftEntry {
  readonly id: string
  /**
   * The session's own title, or `''` when the host has not titled it yet.
   *
   * Deliberately NOT `titleOf(session)` here: that falls back to the session id,
   * and the user's rule for this section is that an untitled new conversation is
   * shown as "新会话", not as a raw id (2026-10-31). Translating that string is
   * the panel's job — this module is the pure state machine and carries no
   * locale. `untitled` is what lets the panel tell the two cases apart.
   */
  readonly untitled: boolean
  /**
   * `SessionListMetadata.blank` — the folded prefix holds no turn yet.
   *
   * That is exactly "a workspace's NEW conversation": it exists in the workspace
   * but nothing has been sent in it. The panel draws the host's folder glyph on
   * these rows so they can be told apart from old conversations that merely still
   * have a draft (user, 2026-10-31).
   *
   * WHY THIS AND NOT A TITLE CHECK: the host gives a blank session a non-empty
   * `displayTitle` — `displayTitleOf()` falls back to the workspace name derived
   * from `cwd`, so a title-based test cannot distinguish "new conversation in a
   * workspace" from "old conversation that has a title". `blank` is the only
   * field that says it directly.
   */
  readonly newConversation: boolean
  readonly title: string
}

/**
 * The single derivation both the ball and the panel read, so the two can never
 * disagree about a session's colour, its fold state or its expiry. Panel and
 * ball differ only in which of these results they choose to show.
 */
export function deriveView(
  sessions: readonly TaskballSession[],
  statuses: ReadonlyMap<string, TaskballStatus>,
  workspaces: readonly TaskballWorkspace[],
  host: HostState,
  now: number,
  archive: ArchiveState = NO_ARCHIVE_STATE,
  witnesses: FlightWitnesses = EMPTY_WITNESSES,
  windowMs: number = flightWindowMs(DEFAULT_POLL_MS),
  draftIds: ReadonlySet<string> = NO_DRAFT_IDS,
): DerivedView {
  const workspaceOf = new Map<string, string>()
  for (const workspace of workspaces) {
    // `sessionIds` is read straight off the host's workspace row. A workspace
    // that is still loading, or a row shape that changed, would otherwise throw
    // here and take the whole overlay down with it (the slot's error boundary
    // unmounts on the first throw). Tolerating a missing list costs nothing:
    // the session simply lands in "ungrouped".
    if (!Array.isArray(workspace?.sessionIds)) continue
    for (const id of workspace.sessionIds) workspaceOf.set(id, workspace.workspaceId)
  }
  const entries: TaskballEntry[] = []
  const failures = new Map<string, string>()
  const colors = new Map<string, TaskballColor>()
  const drafts: DraftEntry[] = []
  const archived = archive.archivedSessionIds
  for (const session of visibleSessions(sessions, draftIds)) {
    // D-005 (user-corrected 2026-10-28): archiving retires a session entirely.
    // It must leave BOTH surfaces — the ball's ring and the panel's active list —
    // so the exclusion happens here, at the one owner both of them read. Keeping
    // it out of `entries` (rather than only out of the ring) is what guarantees
    // the two can never disagree.
    if (archived.has(session.id)) continue
    // F-001: unsent content is its own section, never a task state. It is
    // collected here and never enters `entries`, so a draft can never reach the
    // ring or the counts (user, 2026-10-31: option (a)).
    const record = host.sessions[session.id]
    const liveStatus = statuses.get(session.id)
    // The live flag is a SECOND witness for "this failure has been left behind":
    // without it a user who re-enters a failed session keeps seeing red until the
    // Host's `turnStartAt` arrives on the next poll (measured 0–4999ms).
    const failure = failureOf(
      record,
      liveStatus?.running === true ? { running: true, now } : undefined,
    )
    if (failure !== undefined) failures.set(session.id, failure)
    const completedAt = completedAtOf(record)
    /**
     * Green is a DURABLE fact, not the host's in-memory `completionUnread` flag.
     * That flag lives in a client-side Set that a page reload rebuilds empty, so
     * relying on it alone made every completed session turn gray on refresh
     * (measured: green went 1 → 0 after a reload).
     *
     * The original requirement lists exactly three ways a completed session
     * leaves the panel — re-entering a task, exceeding the retention window, or
     * being marked handled — and "the user looked at it" is not one of them. The
     * Host already records the completion time, so green is derived from that.
     *
     * ORDER MATTERS HERE, and it is the bubble defect of 2026-10-30:
     *
     * 1. A live status wins outright (red / yellow / blue, or green via
     *    `completionUnread`). `completionUnread` is only set for sessions that are
     *    NOT the main view — by design, the host library treats the main view as
     *    "the user is looking at it" — so a FOCUSED session has no live green and
     *    falls through to the Host record.
     * 2. A turn the Host started but has not recorded ending is in flight
     *    (`turnInFlight`). The Host's `turn/end` arrives on the next 5s poll while
     *    `running` flips within a frame, so without this the focused session
     *    flashed GRAY for that gap before turning green. That flash also split the
     *    edge into blue→gray→green, and `transitionsOf` only announces an edge
     *    leaving blue — so the completion bubble could never fire even when
     *    enabled. This branch also stops a stale completion from painting green
     *    once a NEW turn has started (D-004: re-entering a task ends green).
     * 3. Only then does a recorded completion mean green.
     */
    const live = classifyStatus(statuses.get(session.id), failure !== undefined)
    const color: TaskballColor = live !== 'gray'
      ? live
      : turnInFlight(record, witnesses.get(session.id), now, windowMs)
        ? 'blue'
        : completedAt !== undefined
          ? 'green'
          : 'gray'
    const expired = isGreenExpired(color, completedAt, host.retentionMs, now)
    // F-001: a session that HAS a task state is listed under its workspace, not
    // under the draft section — the same session must never appear twice in one
    // panel. A session with nothing but a draft is the opposite: it belongs ONLY
    // to the draft section, so it is collected here and then skipped before it
    // can reach `entries` / `colors` / `foldedIds`. That skip is what makes
    // "(a) drafts never occupy a sector" structural instead of a filter somebody
    // has to remember to apply (user, 2026-10-31).
    //
    // ORDER IS LOAD-BEARING (reported 2026-10-31): this branch must run BEFORE
    // the expiry `continue`. A draft is not a task state, so the retention
    // window has no business retiring it; when an expired green continued
    // first, a session that still held unsent content disappeared from BOTH
    // surfaces — no draft row and no task row (two real sessions were missing
    // from the panel on this machine). An expired green now means "no visible
    // task state any more", which is exactly the condition under which a
    // draft-bearing session belongs in the draft section.
    const hasTaskState = color !== 'gray' && !expired
    if (draftIds.has(session.id) && !hasTaskState) {
      // `title` stays empty when the host has not titled the session; the PANEL
      // renders it as "新会话" (user, 2026-10-31). Falling back to the session id
      // here would show `session-abc123…` in a row the user described as "新会话".
      const raw = typeof session.title === 'string' ? session.title.trim() : ''
      const display = raw !== '' ? raw : (typeof session.displayTitle === 'string' ? session.displayTitle.trim() : '')
      drafts.push({
        id: session.id,
        title: display,
        untitled: display === '',
        // `blank` is the host's own "no turn yet" flag, which is what makes this
        // a workspace's NEW conversation rather than an old one with a draft.
        newConversation: session.blank === true,
      })
      continue
    }
    // Only a task state can expire. A session that reached here has no visible
    // state (gray, or a green past its retention window), and a draft-bearing
    // one already left through the branch above.
    if (expired) continue
    colors.set(session.id, color)
    entries.push({
      id: session.id,
      // `title` has been observed as undefined on rows the host has not titled
      // yet, and the previous `session.title.trim()` threw on exactly that.
      title: titleOf(session),
      color,
      workspaceId: workspaceOf.get(session.id),
      updatedAt: session.updatedAt,
      completedAt,
    })
  }
  return { entries, failures, folded: foldedIds(host, colors), drafts }
}

/** Only the states that mean something to the user; gray is "no task at all". */
export function taskEntries(entries: readonly TaskballEntry[]): TaskballEntry[] {
  return entries.filter((entry) => entry.color !== 'gray')
}

/**
 * One locally-known fold, applied before the Host confirms it (D-034).
 *
 * The Host is the durable owner of a fold, but its answer arrives on the next
 * 5s poll. Waiting for it before repainting made the row's semantics depend on
 * poll timing — the pattern behind BUG1. An override lets both surfaces show the
 * final semantic state immediately; it is reconciled away as soon as the Host
 * reports the same value, or after a bounded time so a failed write heals
 * visibly instead of hiding the row forever.
 */
export interface FoldOverride {
  readonly folded: boolean
  readonly color: TaskballColor
  readonly at: number
}

/**
 * How long an override may outlive the Host's answer. Two poll intervals: one
 * response can be in flight when the write lands, so a single interval is not
 * enough to tell "not applied yet" from "write failed".
 */
export const FOLD_RECONCILE_MS = 10_000

/** The folded set both surfaces read: Host truth with local overrides applied. */
export function overriddenFolds(
  hostFolded: ReadonlySet<string>,
  overrides: ReadonlyMap<string, FoldOverride>,
): ReadonlySet<string> {
  if (overrides.size === 0) return hostFolded
  const next = new Set(hostFolded)
  for (const [id, override] of overrides) {
    if (override.folded) next.add(id)
    else next.delete(id)
  }
  return next
}

/**
 * Drop overrides that no longer carry information: the Host now agrees, the
 * session's colour changed (D-006 cancels a fold on any state change), the row
 * left the derivation, or the safety window passed. Returning the SAME map when
 * nothing changes keeps this usable as a render-stable prune in an effect.
 */
export function pruneFoldOverrides(
  overrides: ReadonlyMap<string, FoldOverride>,
  hostFolded: ReadonlySet<string>,
  colors: ReadonlyMap<string, TaskballColor>,
  now: number,
  timeoutMs: number = FOLD_RECONCILE_MS,
): ReadonlyMap<string, FoldOverride> {
  if (overrides.size === 0) return overrides
  let changed = false
  const next = new Map(overrides)
  for (const [id, override] of overrides) {
    const color = colors.get(id)
    const confirmed = hostFolded.has(id) === override.folded
    const colorChanged = color !== undefined && color !== override.color
    const gone = color === undefined
    const expired = now - override.at > timeoutMs
    if (confirmed || colorChanged || gone || expired) {
      next.delete(id)
      changed = true
    }
  }
  return changed ? next : overrides
}
