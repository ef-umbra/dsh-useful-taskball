import * as React from 'react'
import { BALL_SIZE } from './ball-geometry.js'
import { COLOR_HEX, COLOR_INK, DEFAULT_PALETTE, type Palette } from './palette.js'
import { animatedBallStyle, ballCenterStyle, ballStyle, canAnimateSlices, registerBoundaryProperties, type BallSlice } from './ball-visual.js'
import {
  sectorAngles,
  sectorEntries,
  type TaskballColor,
  type TaskballEntry,
} from './model.js'

const h = React.createElement

const POSITION_KEY = 'dsh-useful-taskball:ball-position'
// Re-exported, not redefined: the size lives in `ball-geometry.ts` so the ring's
// pure visual module and the popups can share it without an import cycle. Callers
// inside this file keep importing it from here, which is why the re-export stays.
export { BALL_SIZE } from './ball-geometry.js'
export const MARGIN = 12

/**
 * How far the pointer must travel from the press point before a press stops
 * being a click and becomes a drag.
 *
 * Measured against the PRESS POINT, never against the previous frame: a slow
 * drag advances a pixel or two per frame, so a per-frame test lets a long careful
 * drag release as a "click" and open the panel (reported 2026-11-01).
 *
 * 4px is the smallest value that absorbs hand tremor and trackpad drift while
 * still feeling immediate; it is the same order as the platform drag slop
 * (`kCmDragThreshold`-style constants are 3–5px). Not a setting: the ball is a
 * 44px target, and a configurable click tolerance would be a knob nobody turns.
 */
export const DRAG_THRESHOLD_PX = 4

/**
 * Snapping (F-007). The host's `AppFrame` is a CSS grid whose CENTER column is
 * the conversation area: its left edge is the sidebar boundary and its right
 * edge is the right sidebar's. Reading that one element gives both lines — the
 * alternative (summing the sidebar column width) needs `data-sidebar-collapsed`
 * which only exists while the sidebar IS collapsed (measured 2026-10-29).
 *
 * Every DOM lookup is by data attribute, never by the host's hash class names
 * (a generated prefix that changes on every host build).
 */
export type SnapX = 'sidebar' | 'rightbar' | 'left' | 'right'
export type SnapY = 'top' | 'bottom'

export interface BallAttachment {
  readonly x?: SnapX | undefined
  readonly y?: SnapY | undefined
}

export interface SnapTarget<T extends string> {
  readonly kind: T
  readonly position: number
}

export interface SnapTargets {
  readonly x: readonly SnapTarget<SnapX>[]
  readonly y: readonly SnapTarget<SnapY>[]
}

/** How close the pointer must land to a line for the ball to stick to it. */
/**
 * How close the pointer must come to a snap line, in CSS px, for the ball to
 * stick to it on release (F-007 / F-019).
 *
 * Now a SETTING (F-019), so this is the default rather than the only value. `0`
 * is meaningful — it disables snapping entirely — which is why the callers pass
 * the setting through explicitly instead of re-deriving it.
 */
export const SNAP_DISTANCE = 16
/**
 * Our own surfaces. The layout observer must ignore attribute writes inside these
 * (the ball writes its own `left` while dragging, the panel animates its styles);
 * otherwise the ball is snapped back onto its line on every drag frame.
 */
const OWN_SURFACE_SELECTOR = '[data-taskball-ball], [data-taskball-panel], [data-taskball-bubble], [data-taskball-quick], [data-taskball-strip]'

/**
 * Whether an event target lives inside one of this plugin's own overlays.
 *
 * Used by BOTH layout observers (the ball's snapping and the strip's placement):
 * our surfaces write styles while dragging and animating, and treating those
 * writes as layout changes makes each surface chase itself.
 */
export function isOwnSurface(target: EventTarget | null): boolean {
  const element = target as Element | null
  return element !== null && typeof element.closest === 'function' && element.closest(OWN_SURFACE_SELECTOR) !== null
}
/**
 * Gap between the ball and a column boundary. Zero would cover the host's 8px
 * resize handle that sits exactly on that line, so the user could no longer drag
 * the sidebar — the ball is clickable and would eat the handle.
 */
export const LINE_GAP = 6

export interface CenterColumn {
  readonly left?: number | undefined
  readonly right?: number | undefined
}

/**
 * The conversation column's horizontal bounds, read from OFFICIAL host anchors.
 *
 * `data-dsh-center-col` was never a host contract: it is injected at runtime by
 * the third-party `dsh-better-sidebar` plugin (`lib/client.js:29286`), so with
 * better-sidebar disabled, upgraded, or simply not installed, snap-to-divider
 * silently degraded to the viewport edges. Verified 2026-10-31 against the host
 * packages:
 *
 * - `[data-rightbar-col]` IS official — `dsh-client-ui-layout`'s `RightbarColumn`
 *   injects it (`lib/client.js:129`), and its `previousElementSibling` is the
 *   `CenterColumn` grid item. That single relation gives BOTH lines: the centre
 *   column's right edge is the rightbar boundary, and its left edge is the
 *   sidebar boundary. Measured on the real page: centre x=280 right=1707 with the
 *   right column collapsed to `0px`.
 *
 * The centre column has no data attribute of its own, which is why the boundary
 * is derived from its sibling rather than queried directly.
 */
export function readCenterColumn(doc: Document | undefined): CenterColumn {
  const rightbar = doc?.querySelector('[data-rightbar-col]')
  const center = rightbar?.previousElementSibling ?? null
  if (center === null) return {}
  const rect = center.getBoundingClientRect()
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right)) return {}
  // A zero-width centre column means the frame has not laid out yet (or the
  // right panel covers everything); reporting it as a snap line would pin the
  // ball at x = 0.
  if (rect.width <= 0) return {}
  return { left: rect.left, right: rect.right }
}

/**
 * The composer card's box, from the host's own `[data-composer-card]`.
 *
 * Official and widely relied upon: `dsh-client-ui-conversation` sets it
 * (`lib/client.js:19173`) and four other official packages query it
 * (agent-preset / input-trigger / message-feedback / model-selection). It is the
 * only element that tracks the composer's real position, which MOVES: measured
 * 2026-10-31, y=778 h=98 with messages and y=447 h=114 in a blank conversation's
 * hero layout. Anything anchored to the composer must therefore re-read this on
 * every layout change rather than cache a number.
 */
export interface ComposerCard {
  readonly left: number
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

export function readComposerCard(doc: Document | undefined): ComposerCard | undefined {
  const card = doc?.querySelector('[data-composer-card]')
  if (card === null || card === undefined) return undefined
  const rect = card.getBoundingClientRect()
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return undefined
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return { bottom: rect.bottom, height: rect.height, left: rect.left, top: rect.top, width: rect.width }
}

/**
 * Snap lines for the current viewport.
 *
 * `ballSize` is threaded through rather than read from the module constant: the
 * lines are "where the ball's LEFT edge must sit", so they depend on its diameter.
 * A default keeps every existing call site (and test) valid while making the
 * dependency visible at the ones that matter (F-018).
 */
export function snapTargets(
  lines: CenterColumn,
  width: number,
  height: number,
  ballSize: number = BALL_SIZE,
): SnapTargets {
  const maxX = Math.max(MARGIN, width - ballSize - MARGIN)
  const maxY = Math.max(MARGIN, height - ballSize - MARGIN)
  return {
    x: [
      { kind: 'left', position: MARGIN },
      ...(lines.left === undefined ? [] : [{ kind: 'sidebar' as const, position: lines.left + LINE_GAP }]),
      ...(lines.right === undefined ? [] : [{ kind: 'rightbar' as const, position: lines.right - ballSize - LINE_GAP }]),
      { kind: 'right', position: maxX },
    ],
    y: [
      { kind: 'top', position: MARGIN },
      { kind: 'bottom', position: maxY },
    ],
  }
}

function nearest<T extends string>(
  targets: readonly SnapTarget<T>[],
  value: number,
  distance: number = SNAP_DISTANCE,
): SnapTarget<T> | undefined {
  let best: SnapTarget<T> | undefined
  let bestDistance = distance
  for (const target of targets) {
    const current = Math.abs(target.position - value)
    if (current > bestDistance) continue
    // `<` keeps the FIRST of two equidistant lines; with one line per axis that
    // only matters if the centre column collapses to zero width.
    best = target
    bestDistance = current
  }
  return best
}

export interface SnapResult {
  readonly position: BallPosition
  readonly attachment: BallAttachment
}

/**
 * Stick to the nearest line per axis. One-shot on purpose: snapping every frame
 * during a drag makes the ball feel like it is fighting the pointer.
 *
 * `distance` is the user's snap reach (F-019). **Zero means "off"** and is
 * handled here rather than left to `nearest`: with `distance = 0`, `nearest` still
 * returns a target when the ball lands EXACTLY on a line, so a user who turned
 * snapping off would still get stuck to a boundary every time they happened to
 * release within a pixel of it. That reads as "the setting does not work".
 */
export function snapPosition(
  position: BallPosition,
  targets: SnapTargets,
  distance: number = SNAP_DISTANCE,
): SnapResult {
  if (!(distance > 0)) {
    return { position, attachment: {} }
  }
  const x = nearest(targets.x, position.x, distance)
  const y = nearest(targets.y, position.y, distance)
  return {
    position: { x: x?.position ?? position.x, y: y?.position ?? position.y },
    attachment: {
      x: x?.kind,
      y: y?.kind,
    },
  }
}

/**
 * Re-apply an existing attachment after the layout moved (sidebar collapsed,
 * right pane opened, window resized). It never INVENTS an attachment: a free
 * ball keeps its own coordinates, so following the layout cannot overwrite a
 * deliberate drag away from the line.
 */
export function followAttachment(
  attachment: BallAttachment,
  targets: SnapTargets,
  position: BallPosition,
): BallPosition {
  const x = attachment.x === undefined ? undefined : targets.x.find((target) => target.kind === attachment.x)
  const y = attachment.y === undefined ? undefined : targets.y.find((target) => target.kind === attachment.y)
  return { x: x?.position ?? position.x, y: y?.position ?? position.y }
}

export interface BallPosition {
  readonly x: number
  readonly y: number
}

export interface BallPlacement {
  readonly position: BallPosition
  readonly attachment: BallAttachment
}

const SNAP_X_VALUES: readonly SnapX[] = ['sidebar', 'rightbar', 'left', 'right']
const SNAP_Y_VALUES: readonly SnapY[] = ['top', 'bottom']

function snapXOf(value: unknown): SnapX | undefined {
  return typeof value === 'string' && (SNAP_X_VALUES as readonly string[]).includes(value) ? value as SnapX : undefined
}

function snapYOf(value: unknown): SnapY | undefined {
  return typeof value === 'string' && (SNAP_Y_VALUES as readonly string[]).includes(value) ? value as SnapY : undefined
}

/**
 * Position is a pure visual preference tied to this screen and window size, so
 * it belongs in `localStorage` rather than in Host state (DECISION.md D-010).
 * The attachment rides along with it: a ball stuck to the sidebar must still be
 * stuck after a reload (F-007), and dropping the field keeps old stored values
 * readable as "free".
 */
export function readPlacement(): BallPlacement | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(POSITION_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown; attachX?: unknown; attachY?: unknown }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return undefined
    return {
      position: { x: parsed.x, y: parsed.y },
      attachment: { x: snapXOf(parsed.attachX), y: snapYOf(parsed.attachY) },
    }
  } catch {
    return undefined
  }
}

export function writePlacement(placement: BallPlacement): void {
  try {
    globalThis.localStorage?.setItem(POSITION_KEY, JSON.stringify({
      x: placement.position.x,
      y: placement.position.y,
      attachX: placement.attachment.x,
      attachY: placement.attachment.y,
    }))
  } catch {
    // A blocked storage quota must not break the ball.
  }
}

export function clampPosition(
  position: BallPosition,
  width: number,
  height: number,
  ballSize: number = BALL_SIZE,
): BallPosition {
  const maxX = Math.max(MARGIN, width - ballSize - MARGIN)
  const maxY = Math.max(MARGIN, height - ballSize - MARGIN)
  return {
    x: Math.min(Math.max(MARGIN, position.x), maxX),
    y: Math.min(Math.max(MARGIN, position.y), maxY),
  }
}

/** Where the collapsed bar sits, derived entirely from the composer card. */
export interface StripBox {
  readonly left: number
  readonly top: number
  /** Free horizontal space between the card and the centre column's left edge. */
  readonly gap: number
}

/**
 * Minimum free space the collapsed bar needs, measured between the composer card's
 * left edge and the centre column's left edge.
 *
 * Measured on the real page 2026-10-31: 128px at a 1707px viewport, 69 at 1200,
 * **33 at 1024, 16 at 900 and below**. So the bar fits comfortably on a wide window
 * and not at all on a narrow one — the collapsed form must refuse to engage rather
 * than squeeze into a 16px gutter.
 *
 * The budget is the bar plus its gap plus a full ball: the user's rule is "always
 * leave a little distance, enough for a whole ball", so restoring must not drop the
 * ball into a gutter narrower than itself. Written as a sum rather than a magic
 * number because that relationship is the actual requirement.
 */
export function stripGutterBudget(stripWidth: number, gapPx: number, ballSize: number = BALL_SIZE): number {
  return stripWidth + gapPx + ballSize
}

/**
 * Place the collapsed bar against the composer card's left edge (F-021).
 *
 * Vertical: centred on the card, NOT on the viewport. The card is where the user
 * is looking (they were typing when they collapsed the ball), and it moves a long
 * way between layouts — 778→447 in the hero case — so centring on the card keeps
 * the bar next to the thing it belongs to. The result is clamped into the viewport
 * for the degenerate case where the card is taller than the screen.
 *
 * Horizontal: `card.left - width - gap`. The gap exists because the card carries a
 * 28px corner radius; a bar flush against it would visually cut into the curve.
 *
 * Returns `undefined` when either anchor is missing or the gutter is too narrow,
 * which is the ONE signal for "stay a ball". Callers must not re-derive this: a
 * second copy of the same arithmetic is how two surfaces end up disagreeing.
 */
export function stripBox(
  card: ComposerCard | undefined,
  center: CenterColumn,
  stripWidth: number,
  stripHeight: number,
  gapPx: number,
  viewportHeight: number,
  ballSize: number = BALL_SIZE,
): StripBox | undefined {
  if (card === undefined || center.left === undefined) return undefined
  const gap = card.left - center.left
  if (gap < stripGutterBudget(stripWidth, gapPx, ballSize)) return undefined
  const left = card.left - stripWidth - gapPx
  if (left < center.left) return undefined
  const ideal = card.top + card.height / 2 - stripHeight / 2
  const top = Math.min(Math.max(MARGIN, ideal), Math.max(MARGIN, viewportHeight - stripHeight - MARGIN))
  return { gap, left, top }
}

export function defaultPosition(width: number, height: number, ballSize: number = BALL_SIZE): BallPosition {
  return clampPosition({ x: width - ballSize - 24, y: height - ballSize - 24 }, width, height, ballSize)
}

/** Sectors in the visual layer's own shape; both the gradient and the frame need it. */
export function slicesOf(entries: readonly TaskballEntry[]): BallSlice[] {
  return sectorAngles(entries).map((sector) => ({ color: sector.color, start: sector.start, end: sector.end }))
}

export interface TaskballBallProps {
  readonly entries: readonly TaskballEntry[]
  readonly folded: ReadonlySet<string>
  readonly expanded: boolean
  readonly onToggle: () => void
  /**
   * Right-click opens the quick settings popup (F-009). Kept separate from
   * `onToggle` so the primary-button path — which carries the drag-vs-click
   * decision — is not touched by a menu gesture.
   */
  readonly onQuick?: (() => void) | undefined
  /**
   * True until both the session list and the Host state have answered once.
   * While loading the ball must say so instead of announcing "no task states":
   * an empty list before the first snapshot means "nothing has arrived", not
   * "nothing exists" (D-033).
   */
  readonly loading?: boolean
  /** Status palette; the colour-blind variant swaps two fills (D-031). */
  readonly palette?: Palette
  /** `'left'` / `'right'` while the open/close spin runs, `undefined` at rest. */
  readonly spin?: 'left' | 'right' | undefined
  /** Reports the settled position so a bubble can anchor to the ball. */
  readonly onPositionChange?: (position: BallPosition) => void
  /**
   * Coordinates to start from, overriding `localStorage`.
   *
   * This is what makes "restore to where it was before collapsing" work. The ball
   * unmounts while collapsed, so on the way back it would otherwise re-read the
   * last SETTLED placement — which is the same thing only until the user drags the
   * ball somewhere, collapses, and the panel/quick window happens to have written a
   * newer position in between. Passing the remembered coordinates makes the restore
   * exact and independent of what else touched storage.
   */
  readonly initialPosition?: BallPosition | undefined
  /**
   * Diameter in CSS px (F-018). Defaults to `BALL_SIZE` (the medium preset).
   *
   * Only the ball scales: the panel and the bubble keep their own sizes and merely
   * re-anchor against this diameter (user 2026-11-01).
   */
  readonly ballSize?: number | undefined
  /**
   * How close a release must be to a snap line to stick (F-019), in CSS px.
   * `0` disables snapping entirely — including dropping an existing attachment.
   */
  readonly snapDistance?: number | undefined
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

export function TaskballBall(props: TaskballBallProps): React.ReactElement {
  const { t, onPositionChange } = props
  const ballSize = props.ballSize ?? BALL_SIZE
  const snapDistance = props.snapDistance ?? SNAP_DISTANCE
  const [position, setPosition] = React.useState<BallPosition | undefined>(undefined)
  // The pointer handlers close over one render's `position`, so a drag that
  // spans several moves would persist the position it started from.
  const latest = React.useRef<BallPosition | undefined>(undefined)
  const release = React.useRef<(() => void) | undefined>(undefined)
  // What the ball is stuck to, kept outside render: it is layout intent, not
  // something the view reads (F-007).
  const attachment = React.useRef<BallAttachment>({})

  const move = (next: BallPosition): void => {
    latest.current = next
    setPosition(next)
  }

  /**
   * Recompute the position from the CURRENT layout: an attached ball follows its
   * line (sidebar collapse, right pane toggle, window resize), a free ball is
   * only clamped. Following never INVENTS an attachment, so it cannot undo a
   * deliberate drag away from a line.
   */
  const applyLayout = (base?: BallPosition): void => {
    const width = globalThis.innerWidth ?? 0
    const height = globalThis.innerHeight ?? 0
    if (width === 0 || height === 0) return
    const targets = snapTargets(readCenterColumn(globalThis.document), width, height, ballSize)
    const reference = base ?? latest.current ?? defaultPosition(width, height, ballSize)
    // Snapping off (F-019) means an EXISTING attachment must also be dropped: the
    // ball is already stuck to a line, and leaving `attachment.current` alone
    // would keep re-pinning it on every resize while the setting says "off".
    if (!(snapDistance > 0)) attachment.current = {}
    const following = attachment.current
    const next = following.x === undefined && following.y === undefined
      ? reference
      : followAttachment(following, targets, reference)
    move(clampPosition(next, width, height, ballSize))
  }

  React.useEffect(() => {
    const stored = readPlacement()
    if (stored !== undefined) attachment.current = stored.attachment
    // `initialPosition` wins over storage: it is the coordinates the user saw the
    // ball at immediately before collapsing, so restoring must land exactly there
    // (user 2026-10-31: 回到收起前的坐标).
    applyLayout(props.initialPosition ?? stored?.position)
    const onResize = (): void => { applyLayout() }
    globalThis.addEventListener?.('resize', onResize)
    // The sidebar can collapse without the window resizing, so the window event
    // alone is not enough. The host writes both column widths into the AppFrame's
    // INLINE STYLE (`grid-template-columns: 280px … 0px`) and toggles the right
    // pane through a `data-rightbar-*` attribute, so the frame's attribute changes
    // are the layout signal. Subtree observation on `document.body` is required:
    // at mount the AppFrame's columns are NOT rendered yet (measured 2026-10-29 —
    // a querySelector for the centre column returned null and the observer never
    // attached), so the observed element cannot be captured up front. A
    // ResizeObserver on the column was tried first and never delivered.
    const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
    const root = globalThis.document?.body ?? globalThis.document?.documentElement
    const observer = Observer === undefined || root === null || root === undefined
      ? undefined
      : new Observer((records) => {
        // Our OWN style writes are not layout changes: while dragging, the ball
        // rewrites its own `left`, and reacting to that would snap it back onto
        // its line on every frame (measured 2026-10-29 — the ball could not be
        // dragged off a line at all).
        if (records.every((record) => isOwnSurface(record.target))) return
        if (attachment.current.x === undefined && attachment.current.y === undefined) return
        applyLayout()
      })
    observer?.observe(root as Node, {
      attributeFilter: ['style', 'class', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
      attributes: true,
      subtree: true,
    })
    return () => {
      globalThis.removeEventListener?.('resize', onResize)
      observer?.disconnect()
      release.current?.()
    }
  }, [])

  React.useEffect(() => {
    if (position !== undefined) onPositionChange?.(position)
  }, [position, onPositionChange])

  // Listeners go on the window, not the ball: once the pointer leaves the ball
  // its own `pointermove` stops firing, so an element-scoped drag freezes as
  // soon as the user moves faster than the ball can follow. Pointer capture
  // would also work, but it is silently unavailable in some embedding shells.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = latest.current
    if (current === undefined || event.button !== 0) return
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    let moved = false
    event.preventDefault()

    const onMove = (raw: Event): void => {
      const moveEvent = raw as PointerEvent
      if (moveEvent.pointerId !== pointerId) return
      const width = globalThis.innerWidth ?? 0
      const height = globalThis.innerHeight ?? 0
      const next = clampPosition({ x: moveEvent.clientX - dx, y: moveEvent.clientY - dy }, width, height, ballSize)
      // The drag-vs-click decision must be the TOTAL displacement from the press
      // point, not the distance covered by this frame.
      //
      // The frame-delta version was wrong and shipped as a bug (reported
      // 2026-11-01): a slow drag moves the pointer a pixel or two per frame, so
      // every frame stayed under the threshold, `moved` never flipped, and
      // releasing after a long careful drag opened the panel. Faster drags worked
      // only because a single frame happened to jump far enough.
      if (Math.abs(moveEvent.clientX - startX) > DRAG_THRESHOLD_PX
        || Math.abs(moveEvent.clientY - startY) > DRAG_THRESHOLD_PX) {
        moved = true
      }
      move(next)
    }

    const onUp = (raw: Event): void => {
      const upEvent = raw as PointerEvent
      if (upEvent.pointerId !== pointerId) return
      finish()
      // A press that never moved is a click: only then does it open the panel,
      // otherwise every drag would toggle the panel on release.
      if (moved) {
        const settled = latest.current
        if (settled === undefined) return
        const width = globalThis.innerWidth ?? 0
        const height = globalThis.innerHeight ?? 0
        const snapped = snapPosition(
          settled,
          snapTargets(readCenterColumn(globalThis.document), width, height, ballSize),
          snapDistance,
        )
        attachment.current = snapped.attachment
        const placed = clampPosition(snapped.position, width, height, ballSize)
        move(placed)
        writePlacement({ position: placed, attachment: snapped.attachment })
        return
      }
      props.onToggle()
    }

    const finish = (): void => {
      globalThis.removeEventListener?.('pointermove', onMove)
      globalThis.removeEventListener?.('pointerup', onUp)
      globalThis.removeEventListener?.('pointercancel', onUp)
      release.current = undefined
    }

    release.current?.()
    release.current = finish
    globalThis.addEventListener?.('pointermove', onMove)
    globalThis.addEventListener?.('pointerup', onUp)
    globalThis.addEventListener?.('pointercancel', onUp)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Shift+F10 is the platform-standard "open the context menu" chord; without
    // it the quick settings popup would be mouse-only (F-009).
    if (event.shiftKey && event.key === 'F10') {
      if (props.onQuick === undefined) return
      event.preventDefault()
      props.onQuick()
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    props.onToggle()
  }

  // The browser's own context menu is replaced, not supplemented: a right-click
  // on the ball means "settings for this ball" everywhere else in this plugin.
  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (props.onQuick === undefined) return
    event.preventDefault()
    props.onQuick()
  }

  const occupying = sectorEntries(props.entries, props.folded)
  const counts = { red: 0, yellow: 0, blue: 0, green: 0 } as Record<TaskballColor, number>
  for (const entry of occupying) counts[entry.color] += 1
  const loading = props.loading === true
  const slices = loading ? [] : slicesOf(occupying)
  // F-010 (D-055): the ring animates by transitioning registered custom
  // properties, which needs a FIXED stop list — so above the slot count the ball
  // falls back to the static gradient rather than dropping sectors.
  const animateSectors = !loading && canAnimateSlices(slices)
  const paletteHex = (props.palette ?? DEFAULT_PALETTE).hex
  const label = loading
    ? t('ball.loading')
    : occupying.length === 0
      ? t('ball.empty')
      : t('ball.summary', { total: occupying.length, red: counts.red, yellow: counts.yellow, blue: counts.blue, green: counts.green })

  return h('div', {
    'aria-expanded': props.expanded,
    'aria-haspopup': props.onQuick === undefined ? undefined : 'dialog',
    'aria-label': label,
    'data-loading': loading ? 'true' : undefined,
    'data-taskball-ball': 'true',
    // Set for the duration of the spin so the CSS transition has a target and
    // then clears, letting the next spin start from zero again. The direction
    // follows the panel: it opens toward the side the ball is on.
    'data-spin': props.spin ?? undefined,
    onContextMenu,
    onKeyDown,
    onPointerDown,
    role: 'button',
    tabIndex: 0,
    title: label,
    style: {
      ...(animateSectors
        ? animatedBallStyle(slices, paletteHex, ballSize)
        : ballStyle(slices, paletteHex, ballSize)),
      bottom: position === undefined ? 24 : undefined,
      // The host sets a global `corner-shape: superellipse(1.5)`, which turns
      // `border-radius: 50%` into a squircle instead of a circle. Every circular
      // surface must opt back into a true round corner.
      cornerShape: 'round',
      cursor: 'pointer',
      height: ballSize,
      left: position?.x,
      pointerEvents: 'auto',
      position: 'fixed',
      // Without a measured position the ball must still land in the intended
      // corner: a fixed element with no inset renders at its static position,
      // which is wherever the overlay layer happens to sit.
      right: position === undefined ? 24 : undefined,
      top: position?.y,
      touchAction: 'none',
      width: ballSize,
      zIndex: 20,
    },
  },
  h('span', { 'aria-hidden': true, style: ballCenterStyle(ballSize) }))
}

export interface BubbleTransition {
  readonly id: string
  readonly from: TaskballColor
  readonly to: TaskballColor
}

/**
 * The colours a bubble can announce. Green used to be conditional on its own
 * switch; it is unconditional now that the user's master switch decides (2026-11-03).
 */
const BUBBLE_WORTHY: ReadonlySet<TaskballColor> = new Set<TaskballColor>(['red', 'yellow', 'green'])

/**
 * Every transition INTO red, yellow or green is announced, but only while the
 * user's master bubble switch is on (user 2026-11-03, superseding D-009 / D-056b:
 * the old `bubbleOnCompletion` gated the green edge alone and left red/yellow
 * permanently unsilenceable). `blue→gray` is not an event at all: it is a
 * finished turn the Host has not recorded yet, not a state change worth
 * announcing.
 *
 * The gate lives HERE rather than at the call site so that "does this edge
 * produce a bubble" stays one question with one answer. Switching it off
 * therefore suppresses every bubble — including a failure.
 */
export function transitionsOf(
  previous: ReadonlyMap<string, TaskballColor>,
  current: ReadonlyMap<string, TaskballColor>,
  bubbleEnabled: boolean,
): BubbleTransition[] {
  if (!bubbleEnabled) return []
  const transitions: BubbleTransition[] = []
  for (const [id, to] of current) {
    const from = previous.get(id)
    if (from === undefined || from === to) continue
    if (from !== 'blue') continue
    if (BUBBLE_WORTHY.has(to)) transitions.push({ id, from, to })
  }
  return transitions
}

export interface TaskballBubbleProps {
  readonly transition: BubbleTransition
  readonly title: string
  readonly anchor: BallPosition | undefined
  readonly viewportWidth: number
  readonly viewportHeight: number
  /**
   * Ball diameter in CSS px (F-018). The bubble's OWN size does not change — only
   * where it sits relative to the ball (which side it flips to, how far it clears
   * the ball's edge). Defaults to the medium preset.
   */
  readonly ballSize?: number | undefined
  /** Status palette; the bubble fill follows the same one as the rows (D-031). */
  readonly palette?: Palette
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/** The bubble flips to the other side of the ball near the right edge (D-009). */
export function bubbleSide(
  anchor: BallPosition | undefined,
  viewportWidth: number,
  ballSize: number = BALL_SIZE,
): 'left' | 'right' {
  if (anchor === undefined) return 'left'
  return anchor.x + ballSize / 2 > viewportWidth / 2 ? 'left' : 'right'
}

/** Vertical placement, kept on screen even when the ball sits at an edge. */
export function bubbleTop(
  anchor: BallPosition | undefined,
  viewportHeight: number,
  height = 30,
  ballSize: number = BALL_SIZE,
): number | undefined {
  if (anchor === undefined) return undefined
  const ideal = anchor.y + ballSize / 2 - height / 2
  return Math.min(Math.max(MARGIN, ideal), Math.max(MARGIN, viewportHeight - height - MARGIN))
}

const BUBBLE_GAP = 8
/**
 * Visual size of the tail's visible triangle, halved from the rotated square.
 *
 * 7 → 5 (user 2026-11-01: 「可以让那个三角形再小一些」). The tail renders as a
 * `TAIL * 2` square rotated 45°, so only `TAIL` px of it shows; 5 keeps a visible
 * notch at 1x DPR while reading as a detail instead of a banner.
 */
export const TAIL = 5
/**
 * Outline weight of the bubble's single silhouette.
 *
 * Was 0.5px. A half-pixel `drop-shadow` is anti-aliased into near-invisibility on
 * 1x displays — the same failure D-037 documented for the panel row outline
 * (`row-tint-outline`). The outline traces the union of body and tail, so it is
 * the ONLY thing separating the bubble from a similarly-coloured background; if
 * it disappears the bubble looks like it is floating without an edge. 0.75px
 * survives anti-aliasing at 1x while staying far from a border.
 *
 * Sharing the number with the row outline is deliberate: both are "the thinnest
 * line that is still visible", and having two different answers would be a bug.
 */
export const BUBBLE_OUTLINE_PX = 0.75

/**
 * The bubble is a chat bubble, not a toast: it carries a tail pointing back at
 * the ball, its fill is the NEW state colour, and its ink is the host's own
 * label colour so it reads as part of the app in both themes (user request 2).
 *
 * Body and tail are ONE element with ONE outline (user's design, 2026-10-27).
 * Two stacked shapes always leave a seam — a hairline where the fills meet, or a
 * doubled border — so the whole silhouette is a single rounded rectangle whose
 * ball-facing side is drawn with a notch. `clip-path` gives the notch its exact
 * shape while `border-radius` keeps the corners circular, and because there is
 * only one box there is only one outline.
 *
 * The tail's two inner corners are vertically centred (not flush with the top
 * and bottom edges), matching the reference: its 20px height sits inside a
 * 47.7px body with ~29% inset top and bottom.
 */
export function TaskballBubble(props: TaskballBubbleProps): React.ReactElement {
  const { anchor, viewportWidth } = props
  const ballSize = props.ballSize ?? BALL_SIZE
  const side = bubbleSide(anchor, viewportWidth, ballSize)
  const top = bubbleTop(anchor, props.viewportHeight, undefined, ballSize)
  const palette = props.palette ?? DEFAULT_PALETTE
  const fill = palette.hex[props.transition.to]
  const ink = palette.ink[props.transition.to]
  const horizontal = anchor === undefined
    ? { right: 24 }
    : side === 'left'
      ? { right: viewportWidth - anchor.x + BUBBLE_GAP }
      : { left: anchor.x + ballSize + BUBBLE_GAP }
  return h('div', {
    'data-taskball-bubble': props.transition.to,
    'data-side': side,
    role: 'status',
    style: {
      // F10 (user, 2026-10-28): the whole silhouette gets ONE continuous outer
      // line. A `border` on the body cannot do that — it would draw across the
      // notch where the tail meets it. Instead the body and tail are both
      // borderless fills and the outline comes from a `drop-shadow` on the
      // wrapper, which traces the union of the two shapes and therefore
      // follows the notch. `filter` on the wrapper also keeps the shadow and
      // the outline on the same layer, so no seam appears between them.
      filter: `drop-shadow(0 0 ${BUBBLE_OUTLINE_PX}px rgba(15, 23, 42, 0.55)) drop-shadow(0 6px 20px rgba(0, 0, 0, 0.22))`,
      color: ink,
      fontSize: 12,
      fontWeight: 500,
      maxWidth: 240,
      pointerEvents: 'none',
      position: 'fixed',
      top,
      whiteSpace: 'nowrap',
      zIndex: 21,
      ...horizontal,
    },
  },
  // The body is now a plain fill: its outline is the wrapper's drop-shadow.
  h('span', {
    style: {
      background: fill,
      borderRadius: 12,
      cornerShape: 'round',
      display: 'block',
      padding: '7px 11px',
      position: 'relative',
    },
  }, props.t(`bubble.${props.transition.to}`, { title: props.title })),
  // Tail: a rotated square whose two visible vertices sit INSIDE the body's
  // vertical extent (design: ~29% inset top and bottom), so it reads as a notch
  // cut into the edge rather than a triangle glued to a corner. Its centre is
  // pinned to the body's vertical centre with `top: 50%` + `translateY(-50%)` —
  // pure CSS, no measurement, so it cannot oscillate. It is borderless and sits
  // under the body, which is what removes the join line.
  h('span', {
    'aria-hidden': true,
    style: {
      background: fill,
      borderRadius: 2,
      cornerShape: 'round',
      height: TAIL * 2,
      position: 'absolute',
      top: '50%',
      transform: 'translateY(-50%) rotate(45deg)',
      width: TAIL * 2,
      ...(side === 'left' ? { right: -TAIL } : { left: -TAIL }),
      zIndex: -1,
    },
  }))
}
