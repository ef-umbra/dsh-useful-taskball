import * as React from 'react'
import type { TaskballEntry } from './model.js'
import type { Palette } from './palette.js'

const h = React.createElement

/** The `t` shape both confirm surfaces take from the panel's own props. */
type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Bulk failure confirmation (F-008, option (b) of the DECISION candidates).
 *
 * Shift-clicking a red row's checkbox means "handle every failure at once", which
 * would bypass the per-row guardrail D-006/D-018 put around red. This dialog is
 * that guardrail for the bulk case: it names every session about to move, says
 * in words what will happen, and only the right-hand block commits.
 *
 * A LAYER OVER THE PANEL, not a native <dialog>: `showModal()` would move focus
 * out of the React tree and put a backdrop over the whole host page, while this
 * belongs to the panel and must not disturb the app behind it.
 *
 * Layout follows the panel's own confirm bar (D-038) so the two read as one
 * system: cancel on the left (the safe choice, and where focus lands), the red
 * commit on the right. Esc cancels — a dismissed dialog is always the safe
 * outcome — and focus returns to the row the gesture started from.
 */
export function RedBulkConfirmDialog(props: {
  readonly entries: readonly TaskballEntry[]
  readonly palette: Palette
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly t: Translate
}): React.ReactElement {
  const { entries, palette, t } = props
  const hex = palette.hex
  // Focus lands on CANCEL: the gesture that opens this is a modifier-click, so
  // an accidental open is as likely as a deliberate one.
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => { cancelRef.current?.focus() }, [])

  return h('div', {
    // The backdrop is click-through-safe for the HOST (the overlay is already
    // click-through); it exists to dim the panel behind and to catch the click
    // that closes, so it must not contain the panel itself.
    'data-taskball-bulk-confirm': 'true',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'taskball-bulk-title',
    style: {
      alignItems: 'center',
      // F-023: the dimmer goes through a custom property so the `!important`
      // rule in style.ts keeps it at its own translucency — a skin that rewrites
      // every `[role="dialog"]` background would otherwise make the backdrop
      // near-opaque and hide the panel it is supposed to dim.
      '--taskball-backdrop-fill': 'rgba(15, 23, 42, 0.38)',
      background: 'rgba(15, 23, 42, 0.38)',
      bottom: 0,
      display: 'flex',
      justifyContent: 'center',
      left: 0,
      padding: 12,
      position: 'fixed',
      right: 0,
      top: 0,
      zIndex: 40,
    },
  },
  h('div', {
    style: {
      // Same material rules as the panel itself (D-039): the host's layer token,
      // never a hard-coded hex, so the dialog tracks both themes.
      background: 'var(--dsw-alias-bg-layer-2, #1e293b)',
      border: '1px solid var(--dsw-alias-border-l3, rgba(148, 163, 184, 0.25))',
      borderRadius: 10,
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.28))',
      color: 'var(--dsw-alias-label-primary, #e2e8f0)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      maxHeight: '100%',
      maxWidth: '100%',
      overflow: 'hidden',
      padding: 12,
      width: 264,
    },
  },
  h('div', {
    id: 'taskball-bulk-title',
    style: { fontSize: '0.95em', fontWeight: 600 },
  }, t('panel.bulkRed.title')),
  h('div', {
    style: { color: 'var(--dsw-alias-label-secondary, #94a3b8)', fontSize: '0.85em', lineHeight: 1.45 },
  }, t('panel.bulkRed.body', { count: entries.length })),
  // The list is what makes this dialog worth opening: the user confirms a set of
  // named sessions, not an abstract count. Capped and scrollable so a long list
  // cannot push the two blocks off screen.
  h('div', {
    'data-taskball-bulk-list': 'true',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      maxHeight: 168,
      overflow: 'auto',
      // A hairline keeps the list readable against the dialog fill in both themes.
      borderTop: '1px solid var(--dsw-alias-border-l2, rgba(148,163,184,0.22))',
      borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(148,163,184,0.22))',
      padding: '6px 0',
    },
  }, ...entries.map((entry) => h('div', {
    key: entry.id,
    style: { alignItems: 'center', display: 'flex', gap: 6, fontSize: '0.85em', minWidth: 0 },
  },
  h('span', {
    // A solid red chip, the same fill the row's status marker uses, so the list
    // reads as "these are the failures" without a second legend.
    style: {
      background: hex.red,
      borderRadius: '50%',
      cornerShape: 'round',
      flex: 'none',
      height: 6,
      width: 6,
    },
  }),
  h('span', {
    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    title: entry.title,
  }, entry.title)))),
  h('div', { style: { display: 'flex', gap: 8 } },
    h('button', {
      onClick: props.onCancel,
      ref: cancelRef,
      style: {
        background: 'none',
        border: '1px solid var(--dsw-alias-border-l2, rgba(148,163,184,0.35))',
        borderRadius: 6,
        color: 'inherit',
        cursor: 'pointer',
        flex: 1,
        font: 'inherit',
        fontSize: '0.9em',
        minHeight: 28,
        padding: '4px 10px',
      },
      type: 'button',
    }, t('panel.bulkRed.cancel')),
    h('button', {
      onClick: props.onConfirm,
      style: {
        background: hex.red,
        border: 0,
        borderRadius: 6,
        // The tested dark ink, not white: white on this red falls under AA
        // (D-029's ink rule, reused verbatim from the per-row confirm bar).
        color: palette.ink.red,
        cursor: 'pointer',
        flex: 1,
        font: 'inherit',
        fontSize: '0.9em',
        fontWeight: 600,
        minHeight: 28,
        padding: '4px 10px',
      },
      type: 'button',
    }, t('panel.bulkRed.confirm')))))
}

/**
 * The failure confirmation, rebuilt as the user asked for it (D-038): the row
 * slides out to the left and the space it leaves holds two side-by-side blocks —
 * cancel on the left, the red confirm on the right.
 *
 * It is an OVERLAY inside the row's wrapper, so it takes exactly the row's
 * height and the list does not jump when the row leaves and comes back. The row
 * itself stays in the DOM, hidden and `aria-hidden`, so screen readers hear only
 * the two buttons; the confirm button says what it does in words (a red fill is
 * not an accessible name), and Esc cancels.
 */
export function RedConfirmBar(props: {
  readonly entry: TaskballEntry
  readonly palette: Palette
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly t: Translate
}): React.ReactElement {
  const { entry, t } = props
  const hex = props.palette.hex
  // Focus lands on CANCEL, the safe choice: the user opened this by accident as
  // easily as on purpose, and a stray Enter must not hide a failure.
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => { cancelRef.current?.focus() }, [])
  return h('div', {
    'data-taskball-confirm': entry.id,
    role: 'group',
    'aria-label': t('panel.confirmRed.title'),
    style: { display: 'flex', gap: 6, inset: 0, position: 'absolute' },
  },
  h('button', {
    onClick: props.onCancel,
    ref: cancelRef,
    style: {
      background: 'none',
      border: '1px solid var(--dsw-alias-border-l2, rgba(148,163,184,0.35))',
      borderRadius: 6,
      color: 'inherit',
      cursor: 'pointer',
      flex: 1,
      font: 'inherit',
      fontSize: '0.9em',
      minHeight: 24,
      padding: '3px 9px',
    },
    type: 'button',
  }, t('panel.confirmRed.cancel')),
  h('button', {
    onClick: props.onConfirm,
    style: {
      background: hex.red,
      border: 0,
      borderRadius: 6,
      // Solid status fills are the v4.4 palette; ink.red is the tested dark ink
      // that keeps this button at or above 4.5:1 (D-029's ink rule).
      color: props.palette.ink.red,
      cursor: 'pointer',
      flex: 1,
      font: 'inherit',
      fontSize: '0.9em',
      fontWeight: 600,
      minHeight: 24,
      padding: '3px 9px',
    },
    type: 'button',
  }, t('panel.confirmRed.confirm')))
}
