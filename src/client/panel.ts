import * as React from 'react'
import {
  countByColor,
  groupByWorkspace,
  occupiesSector,
  taskEntries,
  visibleSessions,
  type DerivedView,
  type DraftEntry,
  type TaskballColor,
  type TaskballEntry,
  type TaskballWorkspace,
} from './model.js'
import { frostedFilter } from './material.js'
import { BALL_SIZE } from './ball-geometry.js'
import { COLOR_HEX, COLOR_INK, DEFAULT_PALETTE, tintOf, type Palette } from './palette.js'
import { closeIcon, draftIcon, gearIcon } from './panel-icons.js'
import { RedBulkConfirmDialog, RedConfirmBar } from './panel-confirm.js'

const h = React.createElement

/** How a folded row leaves the list; mirrors the Host config union (D-026). */
export type FoldAnimation = 'slide-out' | 'slide-down'
/** How a row states its colour; mirrors the Host config union (2026-11-03: two modes only). */
export type StatusMarker = 'rect' | 'dot'

/**
 * The seam between two rows (F-006). It is drawn between rows only — never
 * between a group label and its first row, and never again between groups,
 * whose 6px gap already separates them.
 */
const ROW_GAP_PX = 0.5

// Re-exported so existing importers keep one import site, while `palette.ts`
// stays the single definition (D-030).
export { COLOR_HEX, COLOR_INK, tintOf } from './palette.js'

/** Must match the CSS keyframe durations in style.ts, or the row is cut short. */
export function exitDurationMs(animation: FoldAnimation | undefined): number {
  return animation === 'slide-down' ? 280 : 220
}

export interface TaskballPanelProps {
  readonly workspaces: readonly TaskballWorkspace[]
  /**
   * The derivation the OVERLAY already computed, instead of re-deriving here.
   *
   * Re-deriving was a second owner for the same facts: the panel's own
   * `deriveView` call omitted the archive set, so an archived session
   * disappeared from the ball but stayed in the panel (measured 2026-10-28).
   * Reading one shared result is what makes "the panel matches the ball" a
   * structural property instead of something to keep in sync by hand.
   */
  readonly view: DerivedView
  readonly expanded: boolean
  /**
   * True until the session list and Host state have answered once. While it is
   * true the panel says "loading" rather than "no task states" — an empty list
   * before the first snapshot is "nothing arrived", not "nothing exists"
   * (D-033).
   */
  readonly loading?: boolean
  readonly showFoldedCount?: boolean
  /** Hides the whole handled section; the fold state itself is untouched. */
  readonly showFoldedSection?: boolean
  readonly foldAnimation?: FoldAnimation
  readonly statusMarker?: StatusMarker
  /**
   * Panel background alpha in percent (F-002 / D-039). 100 is the opaque look
   * every earlier version had, so an absent value must behave exactly like 100.
   */
  readonly panelOpacity?: number
  /** Frosted glass: the host's menu blur over a translucent background (F-002). */
  readonly panelFrosted?: boolean
  /** Which status palette to paint with; defaults to the standard one (D-031). */
  readonly palette?: Palette
  /** Anchored to the ball instead of a fixed corner, so the panel follows it. */
  readonly anchor?: { readonly x: number; readonly y: number } | undefined
  readonly viewportWidth?: number
  /**
   * Ball diameter in CSS px (F-018). The panel's own size never changes; this only
   * decides which side it opens on and how far below the ball it hangs.
   */
  readonly ballSize?: number | undefined
  readonly viewportHeight?: number
  readonly fontFamily?: string | undefined
  readonly fontSizePx?: number | undefined
  readonly onToggleFolded: (id: string, color: TaskballColor, folded: boolean) => void
  readonly onBulkFold?: (ids: readonly string[], folded: boolean) => void
  readonly onOpenSession: (id: string) => void
  readonly onClose: () => void
  /**
   * Opens the quick settings popup (F-009). The ball's right-click is a mouse
   * gesture, and `Shift+F10` only works once the ball has focus, so the panel
   * carries the reachable-the-first-time entry point.
   */
  readonly onOpenQuick?: (() => void) | undefined
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

interface Group {
  readonly key: string
  readonly label: string
  readonly entries: readonly TaskballEntry[]
}

const PANEL_WIDTH = 312
const GAP = 10
const MARGIN = 12
/**
 * Alpha ceiling while frosted (F-002). A fully opaque background hides the blur
 * completely, so the default 100 would make the toggle look broken; capping it
 * is what turns "frosted" into something the user can actually see.
 */
const FROSTED_ALPHA_CAP = 72
export const PANEL_ALPHA_MIN = 30
export const PANEL_ALPHA_MAX = 100

/**
 * Resolve the stored percentage; anything malformed falls back to the DEFAULT
 * look, not to fully opaque.
 *
 * The default is `PANEL_ALPHA_MIN` (30) since D-075, paired with frosting. Falling
 * back to `PANEL_ALPHA_MAX` here would render a solid panel for any malformed or
 * not-yet-arrived value, i.e. the one look this default exists to avoid.
 */
function panelAlpha(opacity: number | undefined, frosted: boolean): number {
  const raw = typeof opacity === 'number' && Number.isFinite(opacity) ? opacity : PANEL_ALPHA_MIN
  const clamped = Math.min(PANEL_ALPHA_MAX, Math.max(PANEL_ALPHA_MIN, raw))
  return frosted ? Math.min(clamped, FROSTED_ALPHA_CAP) : clamped
}

function groupEntries(
  entries: readonly TaskballEntry[],
  workspaces: readonly TaskballWorkspace[],
  ungroupedLabel: string,
): Group[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  const byWorkspace = groupByWorkspace(
    entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      displayTitle: entry.title,
      blank: false,
      updatedAt: entry.updatedAt,
    })),
    workspaces,
  )
  const groups: Group[] = []
  for (const group of byWorkspace) {
    const members = group.sessions
      .map((session) => entryById.get(session.id))
      .filter((entry): entry is TaskballEntry => entry !== undefined)
    if (members.length === 0) continue
    groups.push({
      key: group.key,
      label: group.key === 'ungrouped' ? ungroupedLabel : group.label,
      entries: members,
    })
  }
  return groups
}

/**
 * The panel opens next to the ball and flips side/top to stay on screen. A
 * fixed corner put it far from the ball, so clicking the ball made the panel
 * appear somewhere unrelated to where the user was looking.
 *
 * Anchoring by the ball's TOP edge and growing upward keeps the panel glued to
 * the ball regardless of how tall it turns out to be — anchoring by its own
 * measured height would need a second layout pass and would jump on first open.
 */
export function panelPlacement(
  anchor: { x: number; y: number } | undefined,
  viewportWidth: number,
  viewportHeight: number,
  maxHeight = 420,
  ballSize: number = BALL_SIZE,
): { left?: number | undefined; right?: number | undefined; top?: number | undefined; bottom?: number | undefined; maxHeight: number } {
  if (anchor === undefined) {
    return { right: 24, top: Math.max(MARGIN, viewportHeight - 72 - maxHeight), maxHeight: Math.min(maxHeight, viewportHeight - 96) }
  }
  const opensLeft = anchor.x + PANEL_WIDTH + GAP > viewportWidth
  const left = opensLeft ? undefined : anchor.x
  const right = opensLeft ? Math.max(MARGIN, viewportWidth - anchor.x - ballSize) : undefined
  const limit = Math.max(160, Math.min(maxHeight, viewportHeight - MARGIN * 2))
  // Sit above the ball, bottom-aligned to its top edge. Exactly ONE of
  // `top`/`bottom` may be set: with both plus `max-height` the box pins to the
  // top edge and the panel floats far away from the ball it belongs to.
  const roomAbove = anchor.y - MARGIN
  if (roomAbove >= Math.min(limit, 200)) {
    return { left, right, bottom: viewportHeight - anchor.y + GAP, maxHeight: Math.min(limit, roomAbove) }
  }
  // Not enough room above: hang it below the ball instead.
  const top = anchor.y + ballSize + GAP
  return { left, right, top, maxHeight: Math.max(160, Math.min(limit, viewportHeight - top - MARGIN)) }
}


export function TaskballPanel(props: TaskballPanelProps): React.ReactElement | null {
  const { t } = props
  // One palette for the whole panel: a colour-blind toggle must reach every row,
  // dot, checkbox and the confirm dialog, not just some of them (D-031).
  const palette = props.palette ?? DEFAULT_PALETTE
  const hex = palette.hex
  const inkOf = palette.ink
  const [pendingRed, setPendingRed] = React.useState<string | undefined>(undefined)
  /**
   * Bulk failure confirmation (F-008).
   *
   * Holds the ids the modifier-click is about to fold, so the dialog can name
   * them. Empty means closed. Kept separate from `pendingRed` because the two
   * confirmations are different scopes: one row versus every visible failure.
   */
  const [bulkRedPending, setBulkRedPending] = React.useState<readonly string[]>([])
  /**
   * Whether the click that is about to fire `change` carried Shift.
   *
   * The `change` event has no modifier state, and the `click` event on the same
   * checkbox fires first — so the click records the flag and `change` consumes it.
   * Reading `event.shiftKey` off the change event does not typecheck and would not
   * work at runtime either.
   */
  const shiftHeldRef = React.useRef(false)
  // Ids mid-exit. The fold semantic state is ALREADY applied through
  // `props.view.folded` (D-034): this set only decides which of the two
  // rendered regions paints the row for the animation's duration. Nothing about
  // correctness — ball counts, fold state, the handled section — waits on it.
  const [leaving, setLeaving] = React.useState<ReadonlySet<string>>(() => new Set())
  const leavingTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())

  React.useEffect(() => () => {
    for (const timer of leavingTimers.current.values()) clearTimeout(timer)
    leavingTimers.current.clear()
  }, [])

  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const focusPanel = () => { panelRef.current?.focus() }
  /** Cancel puts the user back on the control they used; confirm goes to the panel. */
  const focusRowCheck = (id: string) => {
    const node = panelRef.current?.querySelector<HTMLInputElement>(`[data-taskball-row="${id}"] input[type="checkbox"]`)
    if (node === null || node === undefined) focusPanel()
    else node.focus()
  }

  // Esc cancels the pending failure confirmation (D-038). It never confirms:
  // a dismissed dialog must be the safe outcome.
  React.useEffect(() => {
    if (pendingRed === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const id = pendingRed
      setPendingRed(undefined)
      focusRowCheck(id)
    }
    globalThis.document?.addEventListener('keydown', onKeyDown)
    return () => globalThis.document?.removeEventListener('keydown', onKeyDown)
  }, [pendingRed])

  // Same contract for the bulk dialog: Esc cancels and returns focus to the
  // panel, because the gesture may have started from any row's checkbox.
  React.useEffect(() => {
    if (bulkRedPending.length === 0) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setBulkRedPending([])
      focusPanel()
    }
    globalThis.document?.addEventListener('keydown', onKeyDown)
    return () => globalThis.document?.removeEventListener('keydown', onKeyDown)
  }, [bulkRedPending])

  // A failure can stop being a failure while its confirmation is open (the
  // session re-runs). The row would vanish and leave a global key listener and a
  // pending id behind, so the pending state follows the entry out.
  React.useEffect(() => {
    if (pendingRed === undefined) return
    if (props.view.entries.some((entry) => entry.id === pendingRed)) return
    setPendingRed(undefined)
  }, [pendingRed, props.view.entries])

  // Semantics come from the overlay, never from an animation timer: the ball
  // reads the same set, so a row that is "handled" is handled on both surfaces
  // from the frame the user clicks (D-034).
  const folded = props.view.folded
  /**
   * A row that is animating out is semantically folded already, so the plain
   * `folded` set would remove it from the active list on the same frame and the
   * exit animation would never render. Subtracting the leaving ids for PAINT
   * ONLY keeps the motion while the semantic state (ball, counts, handled
   * section after the animation) is the final one from the first frame.
   */
  const visualFolded = React.useMemo(() => {
    if (leaving.size === 0) return folded
    const next = new Set(folded)
    for (const id of leaving) next.delete(id)
    return next
  }, [folded, leaving])

  if (!props.expanded) return null

  const view = props.view
  const entries = taskEntries(view.entries)
  // F-001: unsent content, listed ABOVE every workspace group and deliberately
  // not grouped by workspace — a draft belongs to no task, so putting it under a
  // workspace heading would claim an association it does not have (user,
  // 2026-10-31). Empty means the whole section is not rendered at all.
  //
  // `?? []` is load-bearing, not padding: `view` is also constructed by tests and
  // by the overlay's own degrade path, and a missing list must render "no drafts"
  // rather than throw. One throw here unmounts the whole overlay (AGENTS §9).
  const drafts = props.view.drafts ?? []

  // Same predicate the ball uses, not an equivalent one: D-028 requires the two
  // surfaces to agree exactly, and two hand-written filters are how they drift.
  const active = entries.filter((entry) => occupiesSector(entry.color, visualFolded, entry.id))
  // Leaving rows are painted in the active region until their animation ends;
  // suppressing them here is what keeps them from appearing twice.
  const foldedEntries = entries.filter((entry) => !occupiesSector(entry.color, visualFolded, entry.id)
    && !leaving.has(entry.id))
  const groups = groupEntries(active, props.workspaces, t('panel.ungrouped'))
  const counts = countByColor(entries)

  const animateOut = (ids: readonly string[], durationMs: number) => {
    if (ids.length === 0) return
    setLeaving((current) => {
      const next = new Set(current)
      for (const id of ids) next.add(id)
      return next
    })
    for (const id of ids) {
      const existing = leavingTimers.current.get(id)
      if (existing !== undefined) clearTimeout(existing)
      const timer = setTimeout(() => {
        leavingTimers.current.delete(id)
        // Animation over. The row's semantic state has not changed since the
        // click; dropping the paint-only flag moves it into the handled section.
        setLeaving((current) => {
          if (!current.has(id)) return current
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, durationMs)
      leavingTimers.current.set(id, timer)
    }
  }

  const requestToggle = (entry: TaskballEntry, shiftKey: boolean) => {
    // F-008: Shift on a failure means "handle every visible failure". It opens
    // the bulk dialog instead of folding anything, because D-018 keeps red out of
    // one-click bulk actions — the user must see WHICH sessions this covers.
    if (shiftKey && needsRedConfirm(entry.color, folded.has(entry.id))) {
      setBulkRedPending(active.filter((candidate) => candidate.color === 'red').map((candidate) => candidate.id))
      return
    }
    // F-013: Shift on a completed row folds every visible completion, with NO
    // confirmation step. D-006's guardrail is about red specifically — folding a
    // failure hides a fact the user may still need to act on. A completion is the
    // opposite: it is already finished, it expires on its own, and any new turn
    // un-folds it automatically (`isFoldedNow`). Asking twice for that would be
    // ceremony, so this is one round trip like the panel's own bulk button.
    if (shiftKey && entry.color === 'green' && !folded.has(entry.id)) {
      const ids = active.filter((candidate) => candidate.color === 'green').map((candidate) => candidate.id)
      if (ids.length === 0) return
      animateOut(ids, exitDurationMs(props.foldAnimation))
      props.onBulkFold?.(ids, true)
      return
    }
    if (needsRedConfirm(entry.color, folded.has(entry.id))) {
      setPendingRed(entry.id)
      return
    }
    const willFold = !folded.has(entry.id)
    if (willFold) animateOut([entry.id], exitDurationMs(props.foldAnimation))
    props.onToggleFolded(entry.id, entry.color, willFold)
  }

  /**
   * Commit the bulk dialog.
   *
   * The user asked for the red rows to leave together, so the exit animation is
   * played for the whole set in ONE `animateOut` call (one paint update) and the
   * fold is committed in ONE `onBulkFold` (one Host round trip). The per-row
   * confirm path deliberately skips its animation because that row is already
   * slid out of sight; here the rows are still on screen, so motion is what tells
   * the user the set actually left.
   */
  const confirmBulkRed = () => {
    const ids = bulkRedPending
    setBulkRedPending([])
    if (ids.length === 0) return
    animateOut(ids, exitDurationMs(props.foldAnimation))
    props.onBulkFold?.(ids, true)
    focusPanel()
  }

  // Two swatch shapes only (user 2026-11-03: 只保留色条和圆点). The four
  // whole-row modes were removed outright rather than hidden, so no dead branch
  // can be reintroduced by a stale stored value.
  const marker = props.statusMarker ?? 'rect'
  const dot = marker === 'dot'

  const renderRow = (entry: TaskballEntry) => {
    const isFolded = folded.has(entry.id)
    const confirming = pendingRed === entry.id
    const isLeaving = leaving.has(entry.id)
    // The title sits on the panel surface, not on a status fill, so it uses the
    // panel's inherited ink. Kept as a named local because the confirm overlay
    // reuses it.
    const rowInk = 'inherit'
    return h('div', {
      key: entry.id,
      // F-012 (D-040): the slot collapses from 1fr to 0fr while the row animates
      // out, so the panel's height follows continuously. Measuring the row and
      // animating `height` is what F10 already proved would re-trigger itself;
      // `grid-template-rows` needs no measurement at all.
      'data-taskball-slot': 'true',
      'data-anim': props.foldAnimation ?? 'slide-out',
      'data-collapsing': isLeaving ? 'true' : 'false',
      style: { display: 'grid', gridTemplateRows: isLeaving ? '0fr' : '1fr' },
    },
    h('div', {
      // The collapsing row must actually clip: `0fr` takes the track to zero but
      // the row would still paint over its neighbours without overflow hidden.
      style: { display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0, overflow: 'hidden', position: 'relative' },
    },
      h('div', {
        'data-taskball-row': entry.id,
        'data-anim': props.foldAnimation ?? 'slide-out',
        // `data-confirming` is PAINT ONLY: it slides the row out of the way while
        // the two blocks take its place. The fold itself still happens on confirm,
        // so the row is not handled until the user says so (D-006 / D-038).
        'data-confirming': confirming ? 'true' : 'false',
        'data-leaving': isLeaving ? 'true' : 'false',
        'data-marker': marker,
        // The row stays in the DOM so the blocks can take exactly its height; it
        // must not be announced while visually out of the way.
        'aria-hidden': confirming ? 'true' : undefined,
        style: {
          alignItems: 'center',
          display: 'flex',
          gap: 8,
          padding: '3px 0',
          // `slide-out` moves away from the panel's ball-facing side; the panel
          // is always drawn beside the ball, so outward is the viewport edge.
          ...(isLeaving && (props.foldAnimation ?? 'slide-out') === 'slide-out'
            ? { '--taskball-out-dir': '24px' }
            : {}),
        },
      },
      // The colour chip IS the status marker and sits at the far left of the title,
      // so the eye reads status then title as one unit.
      h('span', {
        'data-taskball-swatch': entry.color,
        'aria-hidden': true,
        style: {
          background: hex[entry.color],
          cornerShape: 'round',
          flex: 'none',
          height: dot ? 8 : 14,
          width: dot ? 8 : 4,
          ...(dot ? { borderRadius: '50%' } : {}),
        },
      }),
      h('button', {
        onClick: () => { props.onOpenSession(entry.id) },
        style: {
          background: 'none',
          border: 0,
          color: rowInk,
          cursor: 'pointer',
          flex: 1,
          font: 'inherit',
          minWidth: 0,
          overflow: 'hidden',
          padding: 0,
          textAlign: 'left',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        title: entry.title,
        type: 'button',
      }, entry.title),
      h('input', {
        'aria-label': t('panel.markHandled'),
        'data-taskball-check': entry.color,
        checked: isFolded,
        onChange: () => { requestToggle(entry, shiftHeldRef.current) },
        onClick: (event) => { shiftHeldRef.current = event.shiftKey === true },
        style: {
          '--taskball-check-color': hex[entry.color],
          flex: 'none',
          // WCAG 2.2 AA "Target Size (Minimum)": a bare native checkbox is ~13px,
          // under the 24px minimum, so it is padded out to the full target.
          height: 24,
          margin: 0,
          minHeight: 24,
          minWidth: 24,
          width: 24,
        },
        type: 'checkbox',
      }),
      confirming
        ? h(RedConfirmBar, {
          entry,
          palette,
          t,
          onCancel: () => {
            setPendingRed(undefined)
            focusRowCheck(entry.id)
          },
          onConfirm: () => {
            setPendingRed(undefined)
            // No exit animation here: the row is already out of sight, and the
            // fold semantic must land on the click itself (D-034 / D-038).
            props.onToggleFolded(entry.id, entry.color, true)
            focusPanel()
          },
        })
        : null)))
  }

  /**
   * Rows are wrapped in their own column so the 0.5px seam (F-006) sits between
   * rows and nowhere else: the group label stays outside the wrapper, and the
   * panel's own 6px gap keeps separating groups. A seam between two chip-mode
   * rows simply shows the panel behind it — same rule for both modes.
   */
  const renderRows = (key: string, rows: readonly TaskballEntry[]) => h('div', {
    key,
    'data-taskball-rows': key,
    style: { display: 'flex', flexDirection: 'column', rowGap: ROW_GAP_PX },
  }, ...rows.map(renderRow))

  const sectionLabel = (text: string) => h('div', {
    style: {
      color: 'var(--dsw-alias-label-secondary, #94a3b8)',
      fontSize: '0.85em',
      fontWeight: 600,
      marginBottom: 2,
      // The host ships uppercase section headers; a workspace name must keep
      // its real casing, so nothing here is transformed.
      textTransform: 'none',
    },
  }, text)

  const anchor = props.anchor
  const viewportWidth = props.viewportWidth ?? 0
  const viewportHeight = props.viewportHeight ?? 0
  const placement = panelPlacement(anchor, viewportWidth, viewportHeight, undefined, props.ballSize)
  const fontFamily = props.fontFamily ?? 'var(--dsw-font-family, inherit)'
  const fontSize = props.fontSizePx ?? 13
  // D-075: frosting is ON unless explicitly false. `=== true` would make an absent
  // prop mean "off", which is the OLD default — the panel would then render solid
  // for any caller that does not pass the prop (tests, and the first frame before
  // the Host answers).
  const frosted = props.panelFrosted !== false
  const alpha = panelAlpha(props.panelOpacity, frosted)
  // Alpha 100 is the look every earlier version shipped, so it must resolve to
  // the plain token with no `color-mix` layer: a default that renders even one
  // shade differently would change the panel for every existing user (D-039).
  const panelBackground = alpha >= PANEL_ALPHA_MAX
    ? 'var(--dsw-alias-bg-layer-2, #1e293b)'
    : `color-mix(in srgb, var(--dsw-alias-bg-layer-2, #1e293b) ${alpha}%, transparent)`
  // The host's own menu material, not a hand-rolled blur: the panel should feel
  // like the app's menus in both themes, and the token already carries the
  // saturate() that keeps the blurred text from going grey. The quick settings
  // popup (F-009) wears the same material through the same module.
  const frostedStyle = frostedFilter(frosted)

  return h('div', {
    'data-taskball-panel': 'true',
    'data-open': 'true',
    'data-frosted': frosted ? 'true' : undefined,
    ref: panelRef,
    role: 'dialog',
    tabIndex: -1,
    'aria-label': t('panel.title'),
    style: {
      ...frostedStyle,
      // F-023: the fill goes through a custom property so the `!important` rule
      // in style.ts can carry it past a third-party skin's
      // `[role="dialog"] { background: … !important }`. See that rule for why
      // the inline `background` alone cannot defend itself.
      '--taskball-surface-fill': panelBackground,
      background: panelBackground,
      border: '1px solid var(--dsw-alias-border-l3, rgba(148, 163, 184, 0.25))',
      borderRadius: 10,
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, 0.28))',
      color: 'var(--dsw-alias-label-primary, #e2e8f0)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily,
      fontSize,
      gap: 6,
      bottom: placement.bottom,
      left: placement.left,
      maxHeight: placement.maxHeight,
      overflow: 'auto',
      padding: 10,
      position: 'fixed',
      right: placement.right,
      top: placement.top,
      width: PANEL_WIDTH,
      zIndex: 20,
    },
  },
  // F8 (user, 2026-10-28): the header drops the "任务状态" label and keeps only
  // the four colour balls. The dialog's accessible name still comes from
  // `aria-label`, so removing the visible text does not lose the announcement.
  // The balls are centred on the PANEL, not merely in the space the close button
  // leaves: absolute positioning keeps the optical centre true even though the
  // button on the right is a different width (user, 2026-10-29).
  h('div', { style: { alignItems: 'center', display: 'flex', gap: 8, position: 'relative' } },
    h('div', {
      'data-taskball-counts': 'true',
      style: {
        display: 'flex',
        gap: 6,
        left: '50%',
        position: 'absolute',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      },
    },
    ...(['red', 'yellow', 'blue', 'green'] as const).map((color) => h('span', {
      key: color,
      title: `${color}: ${counts[color]}`,
      style: { background: hex[color], borderRadius: '50%', cornerShape: 'round', display: 'inline-block', height: 8, width: 8 },
    }))),
    h('button', {
      // F-009's keyboard-and-touch entry: the ball's right-click is mouse-only
      // and `Shift+F10` needs the ball focused first, so the popup also gets a
      // visible control where the user already is.
      'aria-label': props.onOpenQuick === undefined ? undefined : t('panel.quickSettings'),
      'data-taskball-quick-trigger': props.onOpenQuick === undefined ? undefined : 'true',
      onClick: props.onOpenQuick,
      style: {
        alignItems: 'center',
        background: 'none',
        border: 0,
        color: 'var(--dsw-alias-label-secondary, #94a3b8)',
        cursor: 'pointer',
        display: props.onOpenQuick === undefined ? 'none' : 'flex',
        font: 'inherit',
        padding: '0 2px',
      },
      type: 'button',
    }, gearIcon()),
    h('button', {
      'aria-label': t('panel.close'),
      onClick: props.onClose,
      // The auto margin stays on the CLOSE button: it claims the free space and
      // therefore carries the gear along to the right edge with it, so the two
      // controls read as one group whether or not the gear is rendered.
      style: {
        alignItems: 'center',
        background: 'none',
        border: 0,
        color: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        font: 'inherit',
        marginLeft: 'auto',
        padding: '0 2px',
      },
      type: 'button',
    }, closeIcon())),
  // The three bulk buttons that used to sit here are gone (user 2026-11-02):
  // Shift+click on a row already covers both bulk cases — red opens the confirm
  // dialog (F-008/D-054) and green folds every completion at once (F-013/D-060) —
  // so the buttons were a second entry point for the same two actions.
  // F-001: the draft section sits ABOVE the workspace groups, is NOT grouped by
  // workspace, and disappears entirely when there is no draft. Each row is the
  // whole click target — a draft has no "handled" semantics, so there is no
  // checkbox to put on the right (user, 2026-10-31).
  //
  // The divider below the draft rows is the section's OWN border, not a sibling
  // element. That is deliberate: an empty draft list renders nothing at all, so
  // the line cannot outlive it — "empty → no draft area → no divider" is a
  // property of the markup rather than a second `drafts.length` check somebody
  // has to keep in sync (user, 2026-10-31: 「草稿区为空时分隔线也要消失」).
  drafts.length === 0
    ? null
    : h('section', {
      key: 'drafts',
      'data-taskball-drafts': 'true',
      style: {
        // Same hairline the panel already uses for internal separation (the bulk
        // dialog's list); `--dsw-alias-border-l2` is theme-aware in both modes.
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(148,163,184,0.22))',
        // Keeps the line off the last row's text; the parent's 6px gap supplies
        // the space below it, so the two sides read as symmetric.
        paddingBottom: 7,
      },
    },
      sectionLabel(t('panel.drafts', { count: drafts.length })),
      h('div', { style: { display: 'flex', flexDirection: 'column', rowGap: ROW_GAP_PX } },
        ...drafts.map((draft: DraftEntry) => {
          // An untitled session is a new conversation that has not been sent yet;
          // the user's rule is that it reads "新会话", never its raw session id
          // (2026-10-31). The wording lives here because `model.ts` is the pure
          // state machine and carries no locale.
          const label = draft.untitled ? t('panel.draftsUntitled') : draft.title
          // EVERY draft row carries a glyph, and WHICH glyph is the distinction
          // the user asked for (2026-10-31): a folder for a workspace's new
          // conversation (never sent), a chat bubble for one that already has
          // turns behind it. Leaving the old-conversation rows blank made the two
          // kinds look like the same thing, which is exactly the report.
          return h('div', {
            key: draft.id,
            'data-taskball-draft': draft.id,
            // Test hook + a stable way for a future change to target these rows
            // without guessing at their contents.
            'data-taskball-draft-new': draft.newConversation ? 'true' : undefined,
            'data-taskball-draft-old': draft.newConversation ? undefined : 'true',
            style: { alignItems: 'center', display: 'flex', gap: 6, minWidth: 0 },
          },
          draftIcon(draft.newConversation, 13),
          h('button', {
            onClick: () => { props.onOpenSession(draft.id) },
            style: {
              background: 'none',
              border: 0,
              color: 'inherit',
              cursor: 'pointer',
              flex: 1,
              font: 'inherit',
              minWidth: 0,
              overflow: 'hidden',
              padding: '3px 0',
              textAlign: 'left',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: label,
            type: 'button',
          }, label))
        }))),
  ...groups.map((group) => h('section', { key: group.key },
    sectionLabel(group.label),
    renderRows(group.key, group.entries))),
  // Every child of this list needs an EXPLICIT key, including the ones that are
  // usually absent. The group sections are keyed by workspace, so their count
  // changes freely — and an unkeyed sibling after them is matched by INDEX, so
  // the frame a workspace section appears or disappears shifts its index and
  // React unmounts + remounts it. For the folded section that remount is
  // user-visible: `<details>` keeps its open/closed state in the DOM, so an
  // expanded "handled" area collapsed itself the moment a row was un-folded back
  // into a workspace that had no active rows before (reported 2026-10-30,
  // reproduced: the `<details>` node identity changed between the two frames).
  // `drafts.length === 0` is part of the condition: a panel that lists draft rows
  // is not empty, and saying "no task states" above them would contradict the
  // rows directly underneath it.
  active.length === 0 && drafts.length === 0
    && (foldedEntries.length === 0 || props.showFoldedSection === false)
    ? h('div', { key: 'empty', style: { color: 'var(--dsw-alias-label-secondary, #94a3b8)', padding: '6px 0' } },
      props.loading === true ? t('panel.loading') : t('panel.empty'))
    : null,
  // Hiding the section only stops rendering it: `foldedAt` stays on the Host, so
  // turning the setting back on brings every handled row straight back.
  props.showFoldedSection === false || foldedEntries.length === 0
    ? null
    : h('section', { key: 'folded' },
      h('details', null,
        h('summary', {
          style: { color: 'var(--dsw-alias-label-secondary, #94a3b8)', cursor: 'pointer', fontSize: '0.85em', fontWeight: 600 },
        }, props.showFoldedCount === false
          ? t('panel.foldedPlain')
          : t('panel.folded', { count: foldedEntries.length })),
        renderRows('folded', foldedEntries))),
  // Last child on purpose: the bulk confirmation covers the panel, so it has to
  // paint above every row and outlive any row that is animating out underneath.
  bulkRedPending.length === 0
    ? null
    : h(RedBulkConfirmDialog, {
      entries: active.filter((entry) => bulkRedPending.includes(entry.id)),
      palette,
      t,
      onCancel: () => {
        setBulkRedPending([])
        focusPanel()
      },
      onConfirm: confirmBulkRed,
    }))
}

export function sectorSummary(entries: readonly TaskballEntry[], folded: ReadonlySet<string>): Record<TaskballColor, number> {
  const counts: Record<TaskballColor, number> = { red: 0, yellow: 0, blue: 0, green: 0, gray: 0 }
  for (const entry of entries) {
    if (occupiesSector(entry.color, folded, entry.id)) counts[entry.color] += 1
  }
  return counts
}

/**
 * Folding a red is the one fold that hides a fact the user may still need, so
 * it is the one fold that asks first (DECISION.md D-006). Unfolding never asks.
 */
export function needsRedConfirm(color: TaskballColor, folded: boolean): boolean {
  return color === 'red' && !folded
}

export { visibleSessions }
