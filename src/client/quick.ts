import * as React from 'react'
import { BALL_SIZE } from './ball-geometry.js'
import { MENU_BACKDROP_FILTER, MENU_SURFACE_FILL } from './material.js'
import { PANEL_ALPHA_MAX, PANEL_ALPHA_MIN } from './panel.js'
import { closeIcon } from './panel-icons.js'
import { FONT_SIZE_MAX_PX, FONT_SIZE_MIN_PX } from './settings.js'
import type { BallPosition } from './ball.js'

const h = React.createElement

/** Narrower than the task panel: this is a menu, not a list of sessions. */
export const QUICK_WIDTH = 248
const QUICK_GAP = 10
const MARGIN = 12
/**
 * Height is only used to decide whether the popup fits ABOVE the ball. It is an
 * estimate on purpose: measuring the real box needs a layout pass plus a second
 * render, and F10 already proved measurement-driven re-renders re-trigger
 * themselves in this host. A wrong estimate costs one clamped `maxHeight`,
 * which is what the popup carries anyway.
 *
 * Raised 288 → 384 when F-020 added two rows (2026-11-01). It must track the row
 * count: too small and the popup flips above the ball on windows where it would
 * actually have fit, which looks like the menu jumping for no reason.
 */
const QUICK_ESTIMATED_HEIGHT = 384
/** The ceiling the popup is still clamped to, regardless of the estimate. */
const QUICK_MAX_HEIGHT = 420

export interface QuickPlacement {
  readonly left?: number | undefined
  readonly right?: number | undefined
  readonly top?: number | undefined
  readonly bottom?: number | undefined
  readonly maxHeight: number
}

/**
 * Place the popup beside the ball, mirroring the task panel's rules: flip
 * horizontally near the right edge, prefer sitting above the ball, hang below
 * when there is no room. Exactly one of `top`/`bottom` is ever set — with both
 * plus `max-height` the box pins to the top edge and floats away from the ball.
 */
export function quickPlacement(
  anchor: BallPosition | undefined,
  viewportWidth: number,
  viewportHeight: number,
  width: number = QUICK_WIDTH,
  ballSize: number = BALL_SIZE,
): QuickPlacement {
  const limit = Math.max(180, Math.min(QUICK_MAX_HEIGHT, viewportHeight - MARGIN * 2))
  if (anchor === undefined) {
    return { maxHeight: limit, right: 24, top: Math.max(MARGIN, viewportHeight - ballSize - 24 - limit) }
  }
  const opensLeft = anchor.x + width + QUICK_GAP > viewportWidth
  const left = opensLeft ? undefined : Math.min(anchor.x, Math.max(MARGIN, viewportWidth - width - MARGIN))
  const right = opensLeft ? Math.max(MARGIN, viewportWidth - anchor.x - ballSize) : undefined
  const roomAbove = anchor.y - MARGIN
  if (roomAbove >= Math.min(limit, QUICK_ESTIMATED_HEIGHT)) {
    return { left, maxHeight: Math.min(limit, roomAbove), right, bottom: viewportHeight - anchor.y + QUICK_GAP }
  }
  const top = anchor.y + ballSize + QUICK_GAP
  return { left, maxHeight: Math.max(180, Math.min(limit, viewportHeight - top - MARGIN)), right, top }
}

/**
 * The settings the popup owns; everything else stays on the plugin page.
 *
 * `bubbleOnCompletion` joined the original four (F-009's appearance set) because
 * "will it pop up when a task finishes" is the one notification question a user
 * asks while looking at the ball — having to open the full settings page to
 * answer it was the actual complaint. It is the SAME field the settings page
 * writes (`bubbleOnCompletion`), not a second flag: two switches for one
 * behaviour would drift apart the first time either surface changed.
 *
 * `statusMarker` and `colorBlindMode` were REMOVED here (user, 2026-11-02):
 * status marker is a set-once taste that nobody flips while looking at the ball,
 * and colour-blind mode is an accessibility choice made once for good. Both stay
 * on the plugin page. `ballSize` took their place — resizing the ball is the one
 * thing a user reaches for *because* they are looking at it.
 */
export interface QuickValues {
  readonly panelFrosted: boolean
  readonly panelOpacity: number
  readonly bubbleOnCompletion: boolean
  /** F-020: whether the "handled" section shows at all. */
  readonly showFoldedSection: boolean
  /** F-020: `host` follows the app's content size, `custom` uses `fontSizePx`. */
  readonly fontSizeMode: string
  readonly fontSizePx: number
  /** F-018 / D-073: the same preset the settings page writes. */
  readonly ballSize: string
}

export interface TaskballQuickProps {
  readonly anchor: BallPosition | undefined
  readonly viewportWidth: number
  readonly viewportHeight: number
  /**
   * Ball diameter in CSS px (F-018). The popup keeps its own width; this only
   * decides which side it opens on and how far below the ball it hangs.
   */
  readonly ballSize?: number | undefined
  readonly values: QuickValues
  /** One field write; the popup itself holds no durable state. */
  readonly onSet: (field: string, value: unknown) => void
  readonly onClose: () => void
  /** Absent when this host offers no settings shell to navigate to. */
  readonly onOpenAllSettings?: (() => void) | undefined
  /**
   * Collapse the ball into the bar (F-021 / D-063).
   *
   * Absent means collapse is unavailable on this host right now — a touch device,
   * or a window too narrow to hold the bar without overlapping the sidebar. The
   * row is then not rendered at all rather than shown disabled: a control that can
   * explain neither why it is off nor when it will work is worse than its absence.
   */
  readonly onCollapse?: (() => void) | undefined
  readonly saveFailed?: boolean
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

const ROW_STYLE: React.CSSProperties = { alignItems: 'center', display: 'flex', gap: 8, justifyContent: 'space-between' }
const LABEL_STYLE: React.CSSProperties = { fontSize: '0.92em' }
const SELECT_STYLE: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-module-platform, transparent)',
  border: '1px solid var(--dsw-alias-border-l1, rgba(148,163,184,0.35))',
  borderRadius: 6,
  color: 'inherit',
  fontSize: '0.92em',
  maxWidth: 132,
  padding: '3px 6px',
}

/**
 * Shared look for the two exit actions that now share a row.
 *
 * `minHeight: 26` keeps each a comfortable pointer target while the row still
 * reads as secondary next to the switches above it — these leave the popup, they
 * do not change a setting.
 */
const ACTION_STYLE: React.CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(148,163,184,0.12))',
  border: 0,
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.9em',
  minHeight: 26,
  padding: '4px 8px',
}

/**
 * Right-click quick settings (F-009).
 *
 * Deliberately a NEW overlay layer rather than a mode of the task panel: the
 * panel lists sessions, this edits the four appearance settings people change
 * while looking at the ball. It wears the host's own menu material
 * (`--dsw-menu-backdrop-filter` + `--dsw-specific-menu`) so it reads as part of
 * the app, and it is frosted unconditionally — a translucent *settings* surface
 * is the requested look, unlike the panel where frosting is a user choice.
 *
 * Every control writes on change: a menu of four switches with a Save button is
 * two decisions where one will do. Writes go through the shared `configForms`
 * entry (B-003), which is also why this component never owns a form.
 */
export function TaskballQuick(props: TaskballQuickProps): React.ReactElement {
  const { t, values } = props
  const placement = quickPlacement(props.anchor, props.viewportWidth, props.viewportHeight, undefined, props.ballSize)
  const ref = React.useRef<HTMLDivElement | null>(null)
  // Focus lands inside the popup: it can be opened from the keyboard, so it must
  // be reachable from the keyboard the moment it exists.
  React.useEffect(() => { ref.current?.focus() }, [])

  const opacity = Math.min(PANEL_ALPHA_MAX, Math.max(PANEL_ALPHA_MIN, Math.round(values.panelOpacity)))

  const switchRow = (
    field: 'panelFrosted' | 'bubbleOnCompletion' | 'showFoldedSection',
    labelKey: string,
  ): React.ReactElement => h('label', {
    style: { ...ROW_STYLE, cursor: 'pointer' },
  },
  h('span', { style: LABEL_STYLE }, t(labelKey)),
  h('input', {
    checked: values[field],
    onChange: (event: { target: { checked: boolean } }) => { props.onSet(field, event.target.checked) },
    style: { accentColor: 'var(--dsw-alias-brand-primary, #3b82f6)', height: 16, width: 16 },
    type: 'checkbox',
  }))

  return h('div', {
    'aria-label': t('quick.title'),
    'data-taskball-quick': 'true',
    ref,
    role: 'dialog',
    tabIndex: -1,
    style: {
      // F-023: same custom-property route as the panel — a third-party skin's
      // `[role="dialog"] { background: … !important }` would otherwise replace
      // the host menu material with a near-opaque box.
      '--taskball-surface-fill': MENU_SURFACE_FILL,
      background: MENU_SURFACE_FILL,
      backdropFilter: MENU_BACKDROP_FILTER,
      border: '1px solid var(--dsw-alias-border-l3, rgba(148, 163, 184, 0.25))',
      borderRadius: 12,
      // `border-box` is what makes `QUICK_WIDTH` the box's ACTUAL width, so
      // `quickPlacement`'s flip threshold is true. With the default content-box
      // this 248px box measured 273.3px on the real page (padding 12 + border 1
      // on each side), i.e. it could overflow the viewport by 25px near the right
      // edge — measured 2026-10-29.
      boxSizing: 'border-box',
      bottom: placement.bottom,
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.28))',
      color: 'var(--dsw-alias-label-primary, #e2e8f0)',
      cornerShape: 'round',
      display: 'flex',
      flexDirection: 'column',
      fontSize: 13,
      gap: 10,
      left: placement.left,
      maxHeight: placement.maxHeight,
      overflow: 'auto',
      padding: 12,
      pointerEvents: 'auto',
      position: 'fixed',
      right: placement.right,
      top: placement.top,
      width: QUICK_WIDTH,
      zIndex: 22,
    },
  },
  h('div', { style: { alignItems: 'center', display: 'flex', gap: 8, justifyContent: 'space-between' } },
    h('span', { style: { fontSize: '0.95em', fontWeight: 600 } }, t('quick.title')),
    h('button', {
      'aria-label': t('quick.close'),
      onClick: props.onClose,
      style: {
        alignItems: 'center',
        background: 'none',
        border: 0,
        color: 'var(--dsw-alias-label-secondary, #94a3b8)',
        cursor: 'pointer',
        display: 'flex',
        font: 'inherit',
        padding: '0 2px',
      },
      type: 'button',
    }, closeIcon())),
  // Ball size replaces the removed status-marker row (user, 2026-11-02): it is
  // the one appearance control a user reaches for *because* they are looking at
  // the ball. Same field the settings page writes (`ballSize`, F-018/D-067).
  h('label', { style: ROW_STYLE },
    h('span', { style: LABEL_STYLE }, t('settings.ballSize.label')),
    h('select', {
      'data-taskball-quick-ballsize': 'true',
      onChange: (event: { target: { value: string } }) => { props.onSet('ballSize', event.target.value) },
      style: SELECT_STYLE,
      value: values.ballSize,
    },
    h('option', { value: 'small' }, t('settings.ballSize.small')),
    h('option', { value: 'medium' }, t('settings.ballSize.medium')),
    h('option', { value: 'large' }, t('settings.ballSize.large')))),
  switchRow('panelFrosted', 'settings.panelFrosted.label'),
  switchRow('bubbleOnCompletion', 'settings.bubbleOnCompletion.label'),
  // F-020 (user 2026-11-01): the two settings people change most often while
  // looking at the panel — whether handled rows stay visible, and how big the
  // text is. Both are the SAME fields the settings page writes, never copies.
  switchRow('showFoldedSection', 'settings.showFoldedSection.label'),
  h('label', { style: ROW_STYLE },
    h('span', { style: LABEL_STYLE }, t('settings.fontSizeMode.label')),
    h('select', {
      onChange: (event: { target: { value: string } }) => { props.onSet('fontSizeMode', event.target.value) },
      style: SELECT_STYLE,
      value: values.fontSizeMode,
    },
    h('option', { value: 'host' }, t('settings.fontSizeMode.host')),
    h('option', { value: 'custom' }, t('settings.fontSizeMode.custom')))),
  // The px stepper only exists while the mode says Custom: showing it disabled
  // would imply the value matters in `host` mode, where it is ignored entirely.
  values.fontSizeMode !== 'custom'
    ? null
    : h('label', { style: ROW_STYLE },
      h('span', { style: LABEL_STYLE }, t('settings.fontSizePx.label')),
      h('input', {
        'aria-label': t('settings.fontSizePx.label'),
        'data-taskball-quick-fontsize': 'true',
        max: FONT_SIZE_MAX_PX,
        min: FONT_SIZE_MIN_PX,
        onChange: (event: { target: { value: string } }) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) props.onSet('fontSizePx', next)
        },
        step: 0.5,
        style: { accentColor: 'var(--dsw-alias-brand-primary, #3b82f6)', width: 96 },
        type: 'number',
        value: values.fontSizePx,
      })),
  h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    h('span', { style: { ...ROW_STYLE, justifyContent: 'space-between' } },
      h('span', { style: LABEL_STYLE }, t('settings.panelOpacity.label')),
      // The number is not decoration: a slider alone cannot say "how much", and
      // the popup has no Save button to read the pending value back from.
      h('span', {
        'data-taskball-quick-opacity': 'true',
        style: {
          color: 'var(--dsw-alias-label-secondary, #94a3b8)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '0.85em',
          minWidth: '3em',
          textAlign: 'right',
        },
      }, `${opacity}%`)),
    h('input', {
      'aria-valuetext': `${opacity}%`,
      max: PANEL_ALPHA_MAX,
      min: PANEL_ALPHA_MIN,
      onChange: (event: { target: { value: string } }) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) props.onSet('panelOpacity', next)
      },
      step: 1,
      style: { accentColor: 'var(--dsw-alias-brand-primary, #3b82f6)', margin: 0, width: '100%' },
      type: 'range',
      value: opacity,
    })),
  props.saveFailed === true
    ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #ef4444)', fontSize: '0.85em' } }, t('quick.saveFailed'))
    : null,
  // "Open all settings" and "collapse to bar" share ONE row (user, 2026-11-02):
  // both are exits from this popup rather than settings, and stacking them as two
  // full-width bars made the menu look like it had two competing primary actions.
  // The collapse hint that used to sit under its button is gone too — the button
  // text already says what happens, and the line was three words of noise in a
  // menu this short.
  props.onOpenAllSettings === undefined && props.onCollapse === undefined
    ? null
    : h('div', { 'data-taskball-quick-actions': 'true', style: { display: 'flex', gap: 8 } },
      props.onOpenAllSettings === undefined
        ? null
        : h('button', {
          'data-taskball-open-all': 'true',
          onClick: props.onOpenAllSettings,
          style: { ...ACTION_STYLE, flex: 1 },
          type: 'button',
        }, t('quick.openAll')),
      props.onCollapse === undefined
        ? null
        : h('button', {
          'data-taskball-collapse': 'true',
          onClick: props.onCollapse,
          style: { ...ACTION_STYLE, flex: 1 },
          type: 'button',
        }, t('quick.collapse'))))
}
