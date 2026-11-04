import * as React from 'react'
import { orderEntries, sectorEntries, type TaskballColor, type TaskballEntry } from './model.js'
import { DEFAULT_PALETTE, type Palette } from './palette.js'

const h = React.createElement

/**
 * The collapsed form: a narrow vertical bar that substitutes for the ball and
 * sits against the composer's left edge (F-021 / D-063).
 *
 * WHY A STRIP AND NOT A SMALLER BALL. The ball answers "what is going on" from a
 * glance at a 44px circle. Collapsed, that same question has to be answered by
 * something that takes almost no room — a bar can do it because a bar is
 * one-dimensional: length encodes the count, colour encodes each status, and the
 * eye reads it top-to-bottom without parsing a circle's angles.
 *
 * The bar is a REPLACEMENT, not an addition: the user's sketch shows the ball
 * collapsed into it, and it lives where the ball was, so there is never a moment
 * where both are on screen.
 */

/** Visual width of the bar. The sketch measures 20 device px at DPR 1.5 → ~13.3 CSS px. */
export const STRIP_WIDTH = 13
/** Visual height. The sketch's five 19px segments plus seams → ~70 CSS px. */
export const STRIP_HEIGHT = 70
/** Below this segment height the seams are dropped entirely (F-007 draft, kept). */
export const MIN_SEAM_SEGMENT_PX = 4
/** Seam width between two segments. Zero when the segments get too short. */
export const SEAM_PX = 1

/**
 * The white frame around the whole bar (user, 2026-11-02).
 *
 * WHY 1px AND NOT 0.5px: the same lesson D-065 recorded for the bubble outline —
 * a 0.5px stroke is anti-aliased away on a 1x display, so the frame would simply
 * not exist there while looking right on a 2x screen. 1px is the thinnest weight
 * that survives every DPR.
 *
 * WHY A BORDER AND NOT A box-shadow RING: `boxSizing: 'border-box'` keeps the
 * bar exactly `STRIP_WIDTH` wide, so the gutter budget in `ball.ts` (which
 * decides whether the bar fits at all) stays correct. A ring drawn outside would
 * make the visual box wider than the constant, which is exactly the mistake
 * D-044 recorded for the quick popup.
 *
 * The frame is DECORATIVE separation, not a focus indicator — the focus ring is
 * the host's own — so WCAG's 2px/3:1 focus rule does not apply to it.
 */
export const STRIP_FRAME_PX = 1
/**
 * Frame colour — WHITE, but backed by a hairline shadow (measured 2026-11-02).
 *
 * The user asked for a white frame. A pure white frame was implemented first and
 * measured: the light theme's gutter and composer card are both
 * `rgb(255,255,255)`, so the frame existed and was completely invisible there
 * (the pixel at the strip's edge read `rgb(140,197,255)` — a blue/white blend,
 * i.e. the frame was present but had nothing to contrast against).
 *
 * A theme-swapped dark frame would fix visibility but stop being "a white frame",
 * which is what was asked for. The fix that keeps the design intent is to draw
 * the white frame AND a very light ink shadow just OUTSIDE it:
 *
 * - the white frame still reads as white wherever the backdrop is darker;
 * - the shadow supplies the missing edge on white backgrounds;
 * - neither consumes layout width, so `STRIP_WIDTH` stays the true box width and
 *   `ball.ts`'s gutter budget keeps telling the truth (the D-044 lesson).
 *
 * The shadow lives in `style.ts` as `--taskball-strip-edge`, theme-scoped, because
 * a fixed ink would be wrong in the dark theme (D-037's lesson).
 */
export const STRIP_FRAME_COLOR = 'rgba(255, 255, 255, 0.92)'
/**
 * The hairline that gives the white frame an edge on white backgrounds.
 *
 * Drawn as a `box-shadow` (not a border) so it adds ZERO layout width; drawn at
 * 1px spread so it sits immediately outside the white frame. Theme-scoped: near
 * black at 22% on light (≈2.0:1 against white — visible as an edge without
 * looking like a grey outline), and a soft white glow on dark where the white
 * frame already separates on its own.
 */
export const STRIP_EDGE_COLOR = 'var(--taskball-strip-edge, rgba(15, 23, 42, 0.22))'

/**
 * Persisted collapse intent.
 *
 * Collapsing is a deliberate, sticky choice: a user who moved the ball out of the
 * way wants it to STAY out of the way across reloads. Like the ball's coordinates
 * this is pure view state, so it lives in `localStorage` rather than Host state
 * (D-010) — and, like the coordinates, a failure to read or write it must degrade
 * to "expanded" instead of breaking the overlay.
 */
export const COLLAPSED_KEY = 'dsh-useful-taskball:collapsed'

export function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) globalThis.localStorage?.setItem(COLLAPSED_KEY, '1')
    else globalThis.localStorage?.removeItem(COLLAPSED_KEY)
  } catch {
    // A blocked quota must not break the ball.
  }
}
/**
 * Horizontal gap to the composer card.
 *
 * Not zero on purpose: the card carries a 28px corner radius, so a bar flush
 * against its left edge would visually intersect the curve on the top and bottom
 * segments. `LINE_GAP` (6px) is the ball's gap to a column boundary; this is the
 * same idea against a rounded corner, and the sketch leaves a comparable gap.
 *
 * Whether the bar FITS is decided by `stripBox` in `ball.ts` — it is the function
 * holding the composer card and the centre column, so it is the only owner of that
 * arithmetic.
 */
export const STRIP_GAP = 4

/** One segment of the bar: one session, one equal slice. */
export interface StripSegment {
  readonly color: TaskballColor
  readonly id: string
}

/**
 * Turn entries into the bar's segments: ONE SEGMENT PER SESSION, n equal parts.
 *
 * This is the locked shape (F-007 draft, confirmed 2026-10-31): "n 个未处理任务
 * → 竖条沿纵向 n 等分，每段填该任务的状态色". The sketch shows it directly — two
 * separate green segments, which a colour-grouped bar would have merged into one.
 * Grouping would be more legible at high counts, but it would also stop the bar
 * from being a per-task readout, and that is the point of the thing.
 *
 * ONLY UNHANDLED TASKS (user 2026-10-31, reported on the shipped 0.7.1): the bar
 * must show exactly what the ball's ring shows. A handled ("已处理") entry stops
 * occupying a sector, so it must stop occupying a segment too — otherwise the
 * bar claims "four tasks" while the ring beside it, one click away, draws three.
 * That is the two-口径 defect D-005 / D-028 already settled for the panel; this
 * surface simply had not been wired to the shared predicate yet.
 *
 * `occupiesSector` is called through `sectorEntries` rather than re-spelled as
 * `!folded.has(id)` here: one predicate, one owner (AGENTS.md §2.11). The gray
 * filter stays because gray is not a fold question — it means "no task state".
 *
 * The empty case still returns one gray segment: the bar is never invisible,
 * because "no tasks" is information and a vanishing control is not (user
 * 2026-10-31: 显示中性灰). Every entry being handled lands here too — the bar
 * goes neutral rather than blank.
 */
export function stripSegments(
  entries: readonly TaskballEntry[],
  folded: ReadonlySet<string> = new Set(),
): StripSegment[] {
  const ordered = orderEntries(sectorEntries(entries, folded))
  if (ordered.length === 0) return [{ color: 'gray', id: '__empty__' }]
  return ordered.map((entry) => ({ color: entry.color, id: entry.id }))
}

/**
 * Whether the seams are drawn at all for this segment count.
 *
 * The seam is decoration; the segment boundaries are not. Dropping the seam when
 * segments fall below `MIN_SEAM_SEGMENT_PX` keeps adjacent same-length runs
 * legible instead of turning the bar into a ladder (F-007 draft, confirmed by the
 * user 2026-10-31: 「小于4px就不要缝了」).
 */
export function seamsVisible(segmentCount: number, heightPx: number = STRIP_HEIGHT): boolean {
  if (segmentCount <= 1) return false
  return heightPx / segmentCount >= MIN_SEAM_SEGMENT_PX
}

/** Height of one segment, in CSS px, before seams are subtracted. */
export function segmentHeight(segmentCount: number, heightPx: number = STRIP_HEIGHT): number {
  const safeCount = Math.max(1, segmentCount)
  return heightPx / safeCount
}

export interface TaskballStripProps {
  readonly entries: readonly TaskballEntry[]
  /**
   * Handled entries, which the bar must NOT draw (user 2026-10-31).
   *
   * Same set the ball's ring reads, and applied through the same
   * `occupiesSector` predicate, so "bar shows what the ball shows" is structural
   * rather than two filters that happen to agree today.
   */
  readonly folded?: ReadonlySet<string>
  /** Screen x of the bar's left edge, already resolved from the composer card. */
  readonly left: number
  /** Screen y of the bar's top edge, already resolved from the composer card. */
  readonly top: number
  /** Status palette; the colour-blind variant must reach this surface too (D-031). */
  readonly palette?: Palette
  /**
   * Click restores the ball at the coordinates it had before collapsing.
   *
   * The ONLY way back. Hover deliberately does nothing to the ball (批注 4:
   * 「纯视觉，点击回到收起前的位置」): a hover swap would teleport the ball whenever
   * the pointer merely crossed the bar on its way somewhere else.
   */
  readonly onRestore: () => void
  /** Right-click opens the quick settings popup, same gesture as the ball. */
  readonly onQuick?: (() => void) | undefined
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * The collapsed bar.
 *
 * It is a real `<button>`, not a decorated div: it has an action (restore the
 * ball), it must be reachable by keyboard, and the UI/UX rules for this project
 * forbid "a clickable div" or an action that only reveals itself on hover. The
 * segments are `aria-hidden` — the accessible name already summarises them, and
 * a screen reader reading five anonymous blocks would be worse than one sentence.
 */
export function TaskballStrip(props: TaskballStripProps): React.ReactElement {
  const palette = props.palette ?? DEFAULT_PALETTE
  const segments = stripSegments(props.entries, props.folded)
  const counts: Record<TaskballColor, number> = { red: 0, yellow: 0, blue: 0, green: 0, gray: 0 }
  let total = 0
  for (const segment of segments) {
    if (segment.color === 'gray') continue
    counts[segment.color] += 1
    total += 1
  }
  const label = total === 0
    ? props.t('ball.empty')
    : props.t('ball.summary', { total, red: counts.red, yellow: counts.yellow, blue: counts.blue, green: counts.green })
  const withSeams = seamsVisible(segments.length)

  return h('button', {
    'aria-label': `${label}。${props.t('strip.restore')}`,
    'data-taskball-strip': 'true',
    'data-strip-segments': String(segments.length),
    'data-strip-seams': withSeams ? 'true' : undefined,
    onClick: props.onRestore,
    onContextMenu: props.onQuick === undefined
      ? undefined
      : (event: React.MouseEvent) => {
        event.preventDefault()
        props.onQuick?.()
      },
    style: {
      background: 'none',
      // The white rim (D-074). Drawn as a real border, not a ring, so the box
      // stays exactly STRIP_WIDTH wide and the gutter budget keeps telling the
      // truth. `border-box` below means the segments are inset by this much.
      border: `${STRIP_FRAME_PX}px solid ${STRIP_FRAME_COLOR}`,
      // The white frame's own edge (D-074). `box-shadow` consumes no layout, so
      // the box stays exactly STRIP_WIDTH wide — the gutter budget depends on it.
      boxShadow: `0 0 0 ${STRIP_FRAME_PX}px ${STRIP_EDGE_COLOR}`,
      // Box sizing matters here for the same reason as the quick popup: the seams
      // are drawn with box-shadow, which does not consume layout, so the button's
      // hit area is exactly STRIP_WIDTH wide.
      boxSizing: 'border-box',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column',
      // 4px rounded ends keep the bar from looking like a cut-off rectangle while
      // staying far from a capsule (a capsule at 13px wide would read as a pill).
      borderRadius: 4,
      cornerShape: 'round',
      height: STRIP_HEIGHT,
      left: props.left,
      overflow: 'hidden',
      padding: 0,
      pointerEvents: 'auto',
      position: 'fixed',
      top: props.top,
      touchAction: 'none',
      width: STRIP_WIDTH,
      zIndex: 20,
    },
    // A bare `<button>` inside a form defaults to `submit`. The overlay is not in
    // a form today, but the collapsed bar must never be the reason a host's form
    // submits, so the type is stated rather than inherited.
    type: 'button',
  },
  ...segments.map((segment, index) => h('span', {
    'aria-hidden': true,
    'data-strip-color': segment.color,
    key: segment.id,
    style: {
      // Equal parts via `flex: 1`: the bar stays exactly STRIP_HEIGHT tall no
      // matter how many sessions there are, and no per-segment rounding can leave
      // a sub-pixel gap at the bottom.
      flex: '1 1 0px',
      background: palette.hex[segment.color],
      // Segments meet edge to edge; the seam is drawn on top as a hairline. It
      // uses the host's theme-aware border token rather than a fixed colour, so
      // dark mode does not get a dirty black line (D-037's lesson).
      boxShadow: withSeams && index > 0 ? `inset 0 ${SEAM_PX}px 0 var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))` : undefined,
      minHeight: 0,
    },
  })))
}
