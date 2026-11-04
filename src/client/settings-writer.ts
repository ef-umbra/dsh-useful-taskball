import * as React from 'react'

/**
 * The shared `configForms` entry as this plugin's two settings surfaces use it.
 * Read-only shape: the provider owns the instance (B-003), we only borrow it.
 */
export interface SettingsFormSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  readonly base: unknown
  readonly revision: number | undefined
  readonly writable: boolean
}

export interface SettingsForm {
  getSnapshot(): SettingsFormSnapshot
  subscribe(listener: () => void): () => void
  /**
   * One namespace mutation. `expectedRevision` is deliberately NOT passed: this
   * writer already serializes its own writes, so the revision it could read
   * before queueing is stale by the time the write runs (measured 2026-10-29:
   * a burst of edits answered `settings/conflict`, and every value except the
   * first was silently dropped). Omitting it means "write unconditionally".
   */
  mutate(ops: readonly SettingsOp[]): Promise<boolean>
}

export type SettingsOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

/** What both surfaces render: the Host's values with local intent laid over them. */
export interface SettingsView {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly values: Readonly<Record<string, unknown>>
  /** Composition base (schema defaults resolved) — the target of "重置". */
  readonly defaults: Readonly<Record<string, unknown>>
  readonly writable: boolean
  /** Fields changed locally but not yet answered by the Host. */
  readonly pending: number
  readonly failed: boolean
}

export interface SettingsWriter {
  getSnapshot(): SettingsView
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): void
  restoreDefault(field: string): void
  /** Settle every queued write; tests use it instead of sleeping. */
  flush(): Promise<void>
}

/**
 * How long a burst of edits is collected before it becomes ONE write.
 *
 * Not a feel-tuning knob — a write is a plugin-entry reload on the Host, so it
 * costs 1–2.7 s (measured 2026-10-29: /api/settings/mutate answered in 1095 ms,
 * then 2734 ms). A slider drag emits an event per pixel; without coalescing
 * every one of them would queue a reload, which is both slower than the user's
 * patience and able to lose the final value (queue conflicts). 220 ms is under
 * the 300 ms "instant" threshold while still collapsing a drag or a keystroke
 * run into one write.
 */
export const WRITE_DELAY_MS = 220

interface Override {
  readonly value: unknown
  readonly unset: boolean
  /** A write carrying this exact override has been queued. */
  sent: boolean
}

const EMPTY_VIEW: SettingsView = {
  status: 'unavailable',
  values: {},
  defaults: {},
  writable: false,
  pending: 0,
  failed: false,
}

const EMPTY_WRITER: SettingsWriter = {
  getSnapshot: () => EMPTY_VIEW,
  subscribe: () => () => {},
  set: () => {},
  restoreDefault: () => {},
  flush: async () => {},
}

function plainRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * The ONE write path for this plugin's settings (D-046).
 *
 * Why a writer instead of "call mutate in each control": three properties only
 * hold when one owner answers them —
 *
 * 1. **Immediate feedback.** Every Host write restarts the plugin entry, so the
 *    authoritative value arrives 1–2.7 s later. Controls therefore render the
 *    local intent first (`overrides`) and reconcile when the answer lands.
 * 2. **One reload per burst.** Edits are collected for `WRITE_DELAY_MS`; a drag
 *    or a fast run of toggles becomes a single mutation, and a change arriving
 *    while a write is in flight joins the next one instead of racing it.
 * 3. **No stale fences.** Writes are queued here, so this writer is the only
 *    place that knows the queue; it therefore writes WITHOUT an
 *    `expectedRevision` rather than sending a revision that is already old.
 *
 * A refusal (or a throw) drops the local intent and reports `failed`, so what
 * the user sees falls back to the Host's truth instead of a value nothing saved.
 */
export function createSettingsWriter(form: SettingsForm, delayMs: number = WRITE_DELAY_MS): SettingsWriter {
  const listeners = new Set<() => void>()
  const overrides = new Map<string, Override>()
  let failed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  const build = (): SettingsView => {
    const snapshot = form.getSnapshot()
    const host = snapshot.value ?? {}
    const defaults = plainRecord(snapshot.base)
    const values: Record<string, unknown> = { ...host }
    for (const [field, override] of overrides) {
      values[field] = override.unset ? defaults[field] : override.value
    }
    return {
      status: snapshot.status,
      values,
      defaults,
      writable: snapshot.writable,
      pending: overrides.size,
      failed,
    }
  }

  let view = build()
  const publish = (): void => {
    view = build()
    for (const listener of listeners) listener()
  }

  const queue = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void flushNow()
    }, delayMs)
  }

  const write = (field: string, value: unknown, unset: boolean): void => {
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) {
      // Nothing to save onto: say so rather than showing a value that will not
      // survive the next read.
      failed = true
      publish()
      return
    }
    overrides.set(field, { value, unset, sent: false })
    failed = false
    publish()
    queue()
  }

  const flushNow = (): Promise<void> => {
    chain = chain.then(async () => {
      const batch = [...overrides].filter(([, override]) => !override.sent)
      if (batch.length === 0) return
      for (const [, override] of batch) override.sent = true
      const ops: SettingsOp[] = batch.map(([field, override]) => (
        override.unset
          ? { op: 'unset', path: [field] }
          : { op: 'set', path: [field], value: override.value }
      ))
      let accepted = false
      try {
        accepted = await form.mutate(ops)
      } catch {
        accepted = false
      }
      // After the round trip the Host is the truth for these fields, accepted or
      // not: keeping the local value on a refusal would show a setting that does
      // not exist. A newer override for the same field has a different identity
      // and stays queued for the next write.
      for (const [field, override] of batch) {
        if (overrides.get(field) === override) overrides.delete(field)
      }
      failed = !accepted
      publish()
    })
    return chain
  }

  // The form is a provider-owned singleton that outlives this writer, so the
  // subscription is intentionally held for the rest of the page lifetime.
  form.subscribe(() => {
    // A Host answer (from this writer or from another surface) lands here.
    const host = form.getSnapshot().value ?? {}
    for (const [field, override] of overrides) {
      if (override.sent) continue
      const same = override.unset ? false : Object.is(host[field], override.value)
      if (same) overrides.delete(field)
    }
    publish()
  })

  return {
    getSnapshot: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (field, value) => { write(field, value, false) },
    restoreDefault: (field) => { write(field, undefined, true) },
    flush: async () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flushNow()
    },
  }
}

const writers = new WeakMap<object, SettingsWriter>()

/** One writer per shared form — the form is the identity that owns the queue. */
export function settingsWriterFor(form: SettingsForm | undefined): SettingsWriter {
  if (form === undefined) return EMPTY_WRITER
  const existing = writers.get(form)
  if (existing !== undefined) return existing
  const created = createSettingsWriter(form)
  writers.set(form, created)
  return created
}

export interface SettingsSession {
  readonly writer: SettingsWriter
  readonly view: SettingsView
}

/** Subscribe one component to the shared writer. */
export function useSettings(form: SettingsForm | undefined): SettingsSession {
  const writer = React.useMemo(() => settingsWriterFor(form), [form])
  const view = React.useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot)
  return { writer, view }
}
