import * as React from 'react'
import { useSettings, type SettingsForm } from './settings-writer.js'

const h = React.createElement

export type { SettingsForm, SettingsFormSnapshot, SettingsOp } from './settings-writer.js'

export interface TaskballSettingsProps {
  readonly view: 'summary' | 'page'
  readonly form: SettingsForm | undefined
  readonly t: (key: string) => string
}

/**
 * The three tabs (F-011). Grouping is by "what is the user looking at when they
 * come here", not by code structure: appearance while looking at the panel,
 * motion while something feels wrong, notification when they want to be told.
 * Display/handled-section switches live under Appearance — they change what the
 * panel shows, and a separate tab holding two switches would read as a mistake.
 */
/**
 * Bounds for the custom panel font size, mirrored from the Host schema.
 *
 * Duplicated on purpose: the Client cannot import `src/host/config.ts` (that is
 * the Server half, and the build purity gate forbids it). The Host schema remains
 * the authority — a value outside these bounds is rejected there, so a stale copy
 * here can only mis-render the stepper, never corrupt the stored setting.
 */
export const FONT_SIZE_MIN_PX = 10
export const FONT_SIZE_MAX_PX = 24

export const FIELD_GROUPS = ['appearance', 'motion', 'notify'] as const
export type FieldGroup = typeof FIELD_GROUPS[number]

interface FieldSpec {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly kind: 'number' | 'switch' | 'select' | 'range'
  readonly group: FieldGroup
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

/**
 * Status-marker choices (2026-11-03: cut to two — the user kept only the colour
 * chip and the dot, and the former `bar` is now `rect` because it is a small
 * rectangle). Not offered in the quick popup (D-073).
 */
export const STATUS_MARKER_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'rect', label: 'settings.statusMarker.rect' },
  { value: 'dot', label: 'settings.statusMarker.dot' },
]

/**
 * THE list of settings. One owner on purpose: it decides what exists and which
 * tab shows it, so a field can never be reachable on two surfaces with two
 * different behaviours. Writing, coalescing and reconciliation belong to
 * `settings-writer.ts` — this page only renders controls that call it.
 */
export const FIELDS: readonly FieldSpec[] = [
  { field: 'completionRetentionMinutes', label: 'settings.retention.label', hint: 'settings.retention.hint', kind: 'number', min: 1, group: 'notify' },
  { field: 'bubbleDurationMs', label: 'settings.bubbleDuration.label', hint: 'settings.bubbleDuration.hint', kind: 'number', min: 100, group: 'motion' },
  { field: 'bubbleOnCompletion', label: 'settings.bubbleOnCompletion.label', hint: 'settings.bubbleOnCompletion.hint', kind: 'switch', group: 'notify' },
  { field: 'showFoldedCount', label: 'settings.showFoldedCount.label', hint: 'settings.showFoldedCount.hint', kind: 'switch', group: 'appearance' },
  { field: 'showFoldedSection', label: 'settings.showFoldedSection.label', hint: 'settings.showFoldedSection.hint', kind: 'switch', group: 'appearance' },
  { field: 'closeOnOutsideClick', label: 'settings.closeOnOutsideClick.label', hint: 'settings.closeOnOutsideClick.hint', kind: 'switch', group: 'motion' },
  { field: 'panelFrosted', label: 'settings.panelFrosted.label', hint: 'settings.panelFrosted.hint', kind: 'switch', group: 'appearance' },
  {
    field: 'panelOpacity',
    label: 'settings.panelOpacity.label',
    hint: 'settings.panelOpacity.hint',
    // A slider, not a number box: the value is a bounded feel-thing the user
    // adjusts while WATCHING the panel, so the control has to show the range
    // (30-100) and where they are inside it (user, 2026-10-29).
    kind: 'range',
    min: 30,
    max: 100,
    unit: '%',
    group: 'appearance',
  },
  { field: 'colorBlindMode', label: 'settings.colorBlindMode.label', hint: 'settings.colorBlindMode.hint', kind: 'switch', group: 'appearance' },
  {
    field: 'foldAnimation',
    label: 'settings.foldAnimation.label',
    hint: 'settings.foldAnimation.hint',
    kind: 'select',
    options: [
      { value: 'slide-out', label: 'settings.foldAnimation.slideOut' },
      { value: 'slide-down', label: 'settings.foldAnimation.slideDown' },
    ],
    group: 'motion',
  },
  {
    field: 'statusMarker',
    label: 'settings.statusMarker.label',
    hint: 'settings.statusMarker.hint',
    kind: 'select',
    options: STATUS_MARKER_OPTIONS,
    group: 'appearance',
  },
  {
    field: 'snapDistance',
    label: 'settings.snapDistance.label',
    hint: 'settings.snapDistance.hint',
    kind: 'number',
    min: 0,
    max: 48,
    step: 4,
    unit: 'px',
    group: 'motion',
  },
  {
    field: 'ballSize',
    label: 'settings.ballSize.label',
    hint: 'settings.ballSize.hint',
    kind: 'select',
    options: [
      { value: 'small', label: 'settings.ballSize.small' },
      { value: 'medium', label: 'settings.ballSize.medium' },
      { value: 'large', label: 'settings.ballSize.large' },
    ],
    group: 'appearance',
  },
  {
    field: 'fontSizeMode',
    label: 'settings.fontSizeMode.label',
    hint: 'settings.fontSizeMode.hint',
    kind: 'select',
    options: [
      { value: 'host', label: 'settings.fontSizeMode.host' },
      { value: 'custom', label: 'settings.fontSizeMode.custom' },
    ],
    group: 'appearance',
  },
  {
    field: 'fontSizePx',
    label: 'settings.fontSizePx.label',
    hint: 'settings.fontSizePx.hint',
    kind: 'number',
    min: 10,
    max: 24,
    step: 0.5,
    group: 'appearance',
  },
]

/** The fields one tab renders, in FIELDS order. */
export function fieldsInGroup(group: FieldGroup): readonly FieldSpec[] {
  return FIELDS.filter((spec) => spec.group === group)
}

function asText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

function parseField(spec: FieldSpec, text: string): { ok: true; value: unknown } | { ok: false } {
  if (spec.kind === 'switch') return { ok: true, value: text === 'true' }
  if (spec.kind === 'select') return { ok: true, value: text }
  // `range` parses exactly like `number`: the slider only changes the control,
  // never how the value is read, checked or written.
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { ok: false }
  if (spec.min !== undefined && parsed < spec.min) return { ok: false }
  if (spec.max !== undefined && parsed > spec.max) return { ok: false }
  return { ok: true, value: parsed }
}

/**
 * The plugin page (F-011 tabs, D-046 real-time write).
 *
 * There is no Save button and no draft-then-commit step: every control writes
 * when it changes, through the shared writer, which shows the new value at once
 * and coalesces the Host write. Editing a NUMBER is the one place that keeps a
 * text draft — "1" is a valid thing to type on the way to "13", and the Host
 * must not be told about it (it is below the field's own minimum, so the
 * parser refuses it; the draft is what lets the user keep typing).
 */
export function TaskballSettings(props: TaskballSettingsProps): React.ReactElement {
  const { t } = props
  if (props.view === 'summary') return h('span', null, t('settings.summary'))

  const { writer, view } = useSettings(props.form)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [tab, setTab] = React.useState<FieldGroup>('appearance')
  const tabRefs = React.useRef(new Map<FieldGroup, HTMLButtonElement | null>())

  if (view.status === 'unavailable') return h('span', null, t('settings.unavailable'))
  if (view.status === 'loading') return h('span', null, t('settings.loading'))

  const disabled = !view.writable
  const textOf = (spec: FieldSpec): string => drafts[spec.field] ?? asText(view.values[spec.field])

  const clearDraft = (field: string): void => {
    setDrafts((current) => {
      if (current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const editText = (spec: FieldSpec, text: string): void => {
    setDrafts((current) => ({ ...current, [spec.field]: text }))
    const parsed = parseField(spec, text)
    // Invalid intermediates stay local: typing "1" toward "13" must not write a
    // value the field itself refuses.
    if (parsed.ok) writer.set(spec.field, parsed.value)
  }

  const commitText = (spec: FieldSpec): void => {
    if (drafts[spec.field] === undefined) return
    const parsed = parseField(spec, drafts[spec.field] ?? '')
    if (parsed.ok) writer.set(spec.field, parsed.value)
    // Either way the draft ends here: a value that still does not parse goes back
    // to what the Host actually holds, instead of sitting there looking saved.
    clearDraft(spec.field)
  }

  const restoreDefault = (spec: FieldSpec): void => {
    clearDraft(spec.field)
    writer.restoreDefault(spec.field)
  }

  /**
   * Real tab semantics, not decorated divs: arrow keys move between tabs, and
   * the selected tab owns the only focusable stop in the tablist (roving
   * tabindex). A tablist nobody can reach by keyboard is a tablist that only
   * exists for the mouse.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? FIELD_GROUPS.length - 1
        : step === 0
          ? undefined
          : (index + step + FIELD_GROUPS.length) % FIELD_GROUPS.length
    if (next === undefined) return
    event.preventDefault()
    const group = FIELD_GROUPS[next]
    if (group === undefined) return
    setTab(group)
    tabRefs.current.get(group)?.focus()
  }

  const renderField = (spec: FieldSpec) => {
    const id = `taskball-config-${spec.field}`
    const text = textOf(spec)
    return h('div', { key: spec.field, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('label', { htmlFor: id, style: { fontSize: 13, fontWeight: 600 } }, t(spec.label)),
      spec.kind === 'switch'
        ? h('input', {
          checked: view.values[spec.field] === true,
          disabled,
          id,
          onChange: (event: { target: { checked: boolean } }) => {
            writer.set(spec.field, event.target.checked)
          },
          style: { accentColor: 'var(--dsw-alias-brand-primary, #3b82f6)', height: 16, width: 16 },
          type: 'checkbox',
        })
        : spec.kind === 'select'
          ? h('select', {
            disabled,
            id,
            onChange: (event: { target: { value: string } }) => {
              writer.set(spec.field, event.target.value)
            },
            style: {
              background: 'var(--dsw-alias-bg-module-platform, transparent)',
              border: '1px solid var(--dsw-alias-border-l1, rgba(148,163,184,0.35))',
              borderRadius: 6,
              color: 'inherit',
              fontSize: 13,
              padding: '5px 8px',
              width: 160,
            },
            value: text,
          }, ...(spec.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, t(option.label))))
          : spec.kind === 'range'
            ? h('div', { style: { alignItems: 'center', display: 'flex', gap: 10, width: 220 } },
              h('input', {
                'aria-valuetext': `${text}${spec.unit ?? ''}`,
                disabled,
                id,
                max: spec.max,
                min: spec.min,
                onChange: (event: { target: { value: string } }) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next)) writer.set(spec.field, next)
                },
                step: spec.step ?? 1,
                style: {
                  accentColor: 'var(--dsw-alias-brand-primary, #3b82f6)',
                  flex: 1,
                  margin: 0,
                  minWidth: 0,
                },
                type: 'range',
                value: text,
              }),
              // The live number is not decoration: a slider alone cannot tell
              // "how much", and the saved value must be readable while dragging.
              h('span', {
                'data-taskball-range-value': spec.field,
                style: {
                  color: 'var(--dsw-alias-label-secondary, #94a3b8)',
                  flex: 'none',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 12,
                  minWidth: '3em',
                  textAlign: 'right',
                },
              }, `${text}${spec.unit ?? ''}`))
            : h('input', {
              disabled,
              id,
              max: spec.max,
              min: spec.min,
              onBlur: () => { commitText(spec) },
              onChange: (event: { target: { value: string } }) => { editText(spec, event.target.value) },
              step: spec.step ?? 1,
              style: {
                background: 'var(--dsw-alias-bg-base, transparent)',
                border: '1px solid var(--dsw-alias-border-l1, rgba(148,163,184,0.35))',
                borderRadius: 6,
                color: 'inherit',
                fontSize: 13,
                padding: '5px 8px',
                width: 160,
              },
              type: 'number',
              value: text,
            }),
      h('span', { style: { color: 'var(--dsw-alias-label-secondary, #94a3b8)', fontSize: 12 } }, t(spec.hint)),
      h('button', {
        disabled,
        onClick: () => { restoreDefault(spec) },
        style: {
          alignSelf: 'flex-start',
          background: 'none',
          border: 0,
          color: 'var(--dsw-alias-label-secondary, #94a3b8)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          font: 'inherit',
          fontSize: 12,
          padding: 0,
          textDecoration: 'underline',
        },
        type: 'button',
      }, t('settings.reset')))
  }

  return h('div', {
    'data-taskball-settings': 'page',
    style: { display: 'flex', flexDirection: 'column', gap: 14 },
  },
  h('div', {
    'aria-label': t('settings.tabsLabel'),
    'data-taskball-tablist': 'true',
    role: 'tablist',
    style: {
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(148,163,184,0.35))',
      display: 'flex',
      gap: 2,
    },
  }, ...FIELD_GROUPS.map((group, index) => {
    const selected = group === tab
    return h('button', {
      'aria-controls': `taskball-tabpanel-${group}`,
      'aria-selected': selected,
      'data-taskball-tab': group,
      id: `taskball-tab-${group}`,
      key: group,
      onClick: () => { setTab(group) },
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { onTabKeyDown(event, index) },
      ref: (node: HTMLButtonElement | null) => { tabRefs.current.set(group, node) },
      role: 'tab',
      style: {
        // The active tab is marked by an underline INSIDE the row's own border,
        // so the switch is visible without moving anything around it.
        background: 'none',
        border: 0,
        borderBottom: selected ? '2px solid var(--dsw-alias-brand-primary, #3b82f6)' : '2px solid transparent',
        color: selected ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, #94a3b8)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 13,
        fontWeight: selected ? 600 : 500,
        marginBottom: -1,
        padding: '5px 10px',
      },
      tabIndex: selected ? 0 : -1,
      type: 'button',
    }, t(`settings.tabs.${group}`))
  })),
  h('div', {
    'aria-labelledby': `taskball-tab-${tab}`,
    'data-taskball-tabpanel': tab,
    id: `taskball-tabpanel-${tab}`,
    role: 'tabpanel',
    style: { display: 'flex', flexDirection: 'column', gap: 14 },
  }, ...fieldsInGroup(tab).map(renderField)),
  // The failure is reported OUTSIDE the tab panels on purpose: a write can fail
  // on a field in another tab, and a message that unmounts with the panel would
  // leave the user editing a document the Host is refusing.
  view.failed ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #ef4444)', fontSize: 12 } }, t('settings.saveFailed')) : null,
  // Saving is the default state of this page, so it says so: without a button
  // there would be no other signal that a change is on its way (or already done).
  h('div', {
    'data-taskball-autosave': view.pending > 0 ? 'pending' : 'idle',
    style: { color: 'var(--dsw-alias-label-secondary, #94a3b8)', fontSize: 12 },
  }, view.pending > 0 ? t('settings.saving') : t('settings.autoSave')))
}
