import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One recorded `turn/end`. The Host never judges whether it is a failure:
 * `isFailureKind` lives in the Client model, so the durable record stays a
 * verbatim fact and the semantic table has exactly one owner.
 */
export interface TurnEndRecord {
  readonly kind: string
  readonly cause?: string
  readonly message?: string
  readonly at: number
}

/**
 * Everything the Host knows about one session. The Client derives red,
 * green-age and folded state from these timestamps, so no derived value is
 * ever persisted (a stale derived field is a bug waiting to happen).
 */
export interface SessionRecord {
  turnStartAt?: number
  lastTurnEnd?: TurnEndRecord
  /**
   * Every `turn/end` since the most recent `completed`, oldest first.
   *
   * Keeping only `lastTurnEnd` lost failures: a real session ended
   * `error → aborted(user) → completed`, and the completed end erased the
   * error before anyone could see it. The Client needs the whole tail of the
   * failed attempt to answer "did this session fail and has it recovered
   * since", which is exactly what `completed` answers structurally — not a
   * judgement the Host is allowed to make.
   */
  endsSinceCompletion?: TurnEndRecord[]
  /**
   * Highest event `seq` folded in from cold-start replay.
   *
   * The cursor is a seq, not a timestamp: a synthetic closer reuses the last
   * real event's time, so timestamps repeat and cannot order a log. Absent means
   * "never replayed", which is deliberately distinct from seq 0.
   */
  replayedThroughSeq?: number
  foldedAt?: number
  /**
   * Colour observed when the user folded the entry. D-006 makes the fold
   * auto-cancel once the session's state changes, and only the Host sees the
   * full transition history, so the observed colour travels with the fold.
   */
  foldedColor?: string
}

export interface StoreDocument {
  version: 1
  sessions: Record<string, SessionRecord>
}

/** Completed records are dropped after twice the retention window. */
const COMPLETED_GRACE_FACTOR = 2
/** Upper bound on retained sessions, so the file cannot grow without limit. */
const MAX_SESSIONS = 500
/** A session that keeps failing must not grow its tail without limit. */
const MAX_ENDS_PER_SESSION = 32

export function emptyDocument(): StoreDocument {
  return { version: 1, sessions: {} }
}

function recordOf(document: StoreDocument, sessionId: string): SessionRecord {
  const existing = document.sessions[sessionId]
  if (existing !== undefined) return existing
  const created: SessionRecord = {}
  document.sessions[sessionId] = created
  return created
}

export function applyTurnStart(document: StoreDocument, sessionId: string, at: number): boolean {
  const record = recordOf(document, sessionId)
  if (record.turnStartAt === at) return false
  record.turnStartAt = at
  return true
}

function sameEnd(left: TurnEndRecord | undefined, right: TurnEndRecord): boolean {
  return left !== undefined
    && left.kind === right.kind
    && left.cause === right.cause
    && left.message === right.message
}

/**
 * Idempotent per ending, keeping the FIRST `at` of a repeated one: a
 * gate-blocked session keeps producing `blocked` turns (the loop keeps polling
 * its inbox), and re-stamping the time on every repeat would both churn the
 * file and make the red look fresh forever. See DECISION.md D-007.
 */
export function applyTurnEnd(document: StoreDocument, sessionId: string, end: TurnEndRecord): boolean {
  const record = recordOf(document, sessionId)
  const repeated = sameEnd(record.lastTurnEnd, end)
  /**
   * A completion is a fresh fact every time, unlike a repeated failure.
   *
   * D-007 collapses identical failure endings so a gate-blocked session does not
   * restamp its red forever. `completed` carries different meaning: the Client
   * ages green from this instant and cancels a fold by comparing it to
   * `foldedAt`, so collapsing repeats froze both at the session's FIRST
   * completion. Past the retention window every later completion then looked
   * expired, and green never appeared again (B-008; measured on
   * session-964edce1 — seven completions, the time stuck at the first one,
   * 3h15m behind).
   */
  const restamp = end.kind === 'completed' && record.lastTurnEnd?.at !== end.at
  let changed = false
  // A repeated failure must not restamp the time: the first occurrence is the fact.
  if (!repeated || restamp) {
    record.lastTurnEnd = end
    changed = true
  }

  // `completed` is the structural end of a failed attempt, not a failure
  // judgement: the attempt that followed the failure finished, so the failure
  // is no longer the session's current resting state.
  if (end.kind === 'completed') {
    if (record.endsSinceCompletion === undefined) return changed
    delete record.endsSinceCompletion
    return true
  }

  const tail = record.endsSinceCompletion ?? []
  if (sameEnd(tail[tail.length - 1], end)) return changed
  tail.push(end)
  if (tail.length > MAX_ENDS_PER_SESSION) tail.splice(0, tail.length - MAX_ENDS_PER_SESSION)
  record.endsSinceCompletion = tail
  return true
}

/** `undefined` clears the fold; a timestamp records when the user folded it. */
export function applyFold(
  document: StoreDocument,
  sessionId: string,
  foldedAt: number | undefined,
  foldedColor?: string,
): boolean {
  const record = recordOf(document, sessionId)
  if (record.foldedAt === foldedAt && record.foldedColor === (foldedAt === undefined ? undefined : foldedColor)) {
    return false
  }
  if (foldedAt === undefined) {
    delete record.foldedAt
    delete record.foldedColor
  } else {
    record.foldedAt = foldedAt
    if (foldedColor === undefined) delete record.foldedColor
    else record.foldedColor = foldedColor
  }
  return true
}

function latestActivity(record: SessionRecord): number {
  return Math.max(record.turnStartAt ?? 0, record.lastTurnEnd?.at ?? 0, record.foldedAt ?? 0)
}

/**
 * Drop records that can no longer affect any rendering: finished-and-old
 * sessions nobody folded, plus stale never-ended records. An unresolved
 * failure is never pruned by age (D-004), only by the size cap below.
 */
export function pruneDocument(
  document: StoreDocument,
  now: number,
  retentionMs: number,
): boolean {
  let changed = false
  const staleAfter = retentionMs * COMPLETED_GRACE_FACTOR
  for (const [sessionId, record] of Object.entries(document.sessions)) {
    if (record.foldedAt !== undefined) continue
    if (record.endsSinceCompletion !== undefined && record.endsSinceCompletion.length > 0) continue
    const end = record.lastTurnEnd
    const idle = now - latestActivity(record)
    const finished = end === undefined || end.kind === 'completed'
    if (finished && idle > staleAfter) {
      delete document.sessions[sessionId]
      changed = true
    }
  }
  const entries = Object.entries(document.sessions)
  if (entries.length <= MAX_SESSIONS) return changed
  entries.sort((left, right) => latestActivity(right[1]) - latestActivity(left[1]))
  for (const [sessionId] of entries.slice(MAX_SESSIONS)) {
    delete document.sessions[sessionId]
    changed = true
  }
  return changed
}

function isTurnEndRecord(value: unknown): value is TurnEndRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.kind === 'string' && typeof record.at === 'number'
}

function normalizeEnd(end: TurnEndRecord): TurnEndRecord {
  const withCause = typeof end.cause === 'string'
  const withMessage = typeof end.message === 'string'
  if (withCause && withMessage) return { kind: end.kind, cause: end.cause, message: end.message, at: end.at }
  if (withCause) return { kind: end.kind, cause: end.cause, at: end.at }
  if (withMessage) return { kind: end.kind, message: end.message, at: end.at }
  return { kind: end.kind, at: end.at }
}

function readSessionRecord(value: unknown): SessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const record: SessionRecord = {}
  if (typeof raw.turnStartAt === 'number') record.turnStartAt = raw.turnStartAt
  if (typeof raw.replayedThroughSeq === 'number') record.replayedThroughSeq = raw.replayedThroughSeq
  if (typeof raw.foldedAt === 'number') {
    record.foldedAt = raw.foldedAt
    if (typeof raw.foldedColor === 'string') record.foldedColor = raw.foldedColor
  }
  if (isTurnEndRecord(raw.lastTurnEnd)) record.lastTurnEnd = normalizeEnd(raw.lastTurnEnd)
  if (Array.isArray(raw.endsSinceCompletion)) {
    const tail = raw.endsSinceCompletion.filter(isTurnEndRecord).map(normalizeEnd)
    if (tail.length > 0) record.endsSinceCompletion = tail.slice(-MAX_ENDS_PER_SESSION)
  }
  return record
}

/** Parse one stored document, discarding anything that does not validate. */
export function parseDocument(text: string): StoreDocument {
  const document = emptyDocument()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return document
  }
  if (typeof parsed !== 'object' || parsed === null) return document
  const sessions = (parsed as { sessions?: unknown }).sessions
  if (typeof sessions !== 'object' || sessions === null) return document
  for (const [sessionId, value] of Object.entries(sessions as Record<string, unknown>)) {
    const record = readSessionRecord(value)
    // A record that validates to nothing carries no fact; keeping it would grow
    // the file with empty shells on every partial write. A replay cursor alone
    // is not a fact either: it records where to resume, not anything renderable,
    // so a session whose only surviving field is the cursor is dropped.
    if (record !== undefined && Object.keys(record).some((key) => key !== 'replayedThroughSeq')) {
      document.sessions[sessionId] = record
    }
  }
  return document
}

export function serializeDocument(document: StoreDocument): string {
  return JSON.stringify(document)
}

/** Absent or unreadable storage is an empty document, never a hard failure. */
export function readDocument(file: string): StoreDocument {
  try {
    return parseDocument(readFileSync(file, 'utf8'))
  } catch {
    return emptyDocument()
  }
}

/** Replace the file through a sibling temp file so a reader never sees half a write. */
export function writeDocument(file: string, document: StoreDocument): boolean {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, serializeDocument(document), 'utf8')
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
