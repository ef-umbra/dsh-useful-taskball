import * as React from 'react'
import { NO_DRAFT_IDS } from './model.js'

export { NO_DRAFT_IDS }

/**
 * Draft detection for F-001, read out of the host's own conversation store.
 *
 * WHERE THE FACT LIVES — verified on this machine 2026-10-28 and re-verified
 * 2026-10-31 against `dsh-client-ui-conversation/lib/client.js`:
 *
 * - the store is `defineStore({ persist: "dsh.conversation" })`, so every
 *   session gets one localStorage key `dsh.conversation.<sessionId>`;
 * - the value is `{ draft, view }`; `draft` is a `DraftSnapshot`
 *   (`{ text, references }`) in current builds and a bare STRING in older ones —
 *   the host itself tolerates both via `parseStoredDraft`;
 * - the write happens on input events, not on blur or unmount (measured: the key
 *   changed ≤400ms after typing, before any blur), so polling is enough.
 *
 * This is a PRIVATE storage contract, not a documented service: the key prefix,
 * the snapshot shape and the write timing are all host internals that may change.
 * Everything here therefore degrades to "no draft" rather than throwing — a
 * malformed value must never take the overlay down (AGENTS §9: one throw in the
 * overlay unmounts the whole thing through the slot's error boundary).
 */

/** Prefix of the host's per-session conversation store key. */
export const DRAFT_KEY_PREFIX = 'dsh.conversation.'

/**
 * Whether one stored value means "there is unsent content here".
 *
 * Mirrors the host's `parseStoredDraft` semantics: text OR references, non-empty.
 * A draft that is only whitespace is not a draft — the host trims the same way.
 */
export function hasDraftContent(raw: string | null): boolean {
  if (raw === null || raw === '') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  if (!('draft' in parsed)) return false
  const draft = (parsed as { draft: unknown }).draft
  // Legacy shape: before DraftSnapshot existed the draft was a plain string.
  if (typeof draft === 'string') return draft.trim() !== ''
  if (typeof draft !== 'object' || draft === null) return false
  const snapshot = draft as { text?: unknown; references?: unknown }
  const text = typeof snapshot.text === 'string' ? snapshot.text.trim() : ''
  if (text !== '') return true
  const references = snapshot.references
  return Array.isArray(references) && references.length > 0
}

/** Every session id that currently has unsent content. */
export function readDraftIds(storage: Storage | undefined | null): Set<string> {
  const found = new Set<string>()
  if (storage === undefined || storage === null) return found
  let length = 0
  try {
    length = storage.length
  } catch {
    return found
  }
  for (let index = 0; index < length; index += 1) {
    let key: string | null = null
    try {
      key = storage.key(index)
    } catch {
      continue
    }
    if (key === null || !key.startsWith(DRAFT_KEY_PREFIX)) continue
    const sessionId = key.slice(DRAFT_KEY_PREFIX.length)
    if (sessionId === '') continue
    let raw: string | null = null
    try {
      raw = storage.getItem(key)
    } catch {
      continue
    }
    if (hasDraftContent(raw)) found.add(sessionId)
  }
  return found
}

/** Same contents, so a poll that changes nothing does not re-render the panel. */
function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

/**
 * How often the draft keys are re-read.
 *
 * The host writes on input, so the value is fresh within a few hundred ms; this
 * only decides how long our view lags. Matched to the Host-state poll (5s) so
 * the two do not interleave into extra renders. A `storage` event cannot replace
 * the poll: it only fires for OTHER tabs, never for the tab that wrote.
 */
export const DRAFT_POLL_MS = 5000

/** Session ids with unsent content, refreshed on a timer. */
export function useDraftIds(intervalMs: number = DRAFT_POLL_MS): ReadonlySet<string> {
  const [ids, setIds] = React.useState<ReadonlySet<string>>(NO_DRAFT_IDS)
  React.useEffect(() => {
    let disposed = false
    const scan = (): void => {
      if (disposed) return
      const next = readDraftIds(globalThis.localStorage as Storage | undefined)
      // Keep the previous reference when nothing changed: a fresh Set every poll
      // would defeat every `useMemo` downstream and re-render the panel 12×/min.
      setIds((current) => (sameIds(current, next) ? current : next))
    }
    scan()
    const timer = setInterval(scan, intervalMs)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [intervalMs])
  return ids
}
