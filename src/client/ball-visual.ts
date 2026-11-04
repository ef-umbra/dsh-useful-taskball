import type { TaskballColor } from './model.js'
import { BALL_SIZE } from './ball-geometry.js'
import { COLOR_HEX } from './palette.js'

export interface BallSlice {
  readonly color: TaskballColor
  readonly start: number
  readonly end: number
}

const BALL_PX = BALL_SIZE
const FRAME_PX = 1.5
/**
 * The glass disc at the ball's centre, as a FRACTION of the ball's diameter.
 *
 * 16/44 is the v4.4 design value at the 44px ball. It has to be a ratio rather
 * than a fixed 16px because the diameter is a user setting (F-018): a 16px disc
 * on the 56px preset looked like a pinprick that had not been scaled with the
 * ring, and on the 36px one it crowded the sectors (user, 2026-11-02: 「球中心的
 * 模式小圆，不会随着球大小的调整而改变」).
 *
 * A ratio keeps the design's PROPORTION at every preset, which is the thing the
 * eye actually reads. `seamDeg` below solves the opposite problem (a pixel width
 * that must stay constant while its angle shrinks) — the two are deliberately
 * different because one is a solid disc and the other is a hairline.
 */
const CENTER_RATIO = 16 / BALL_SIZE

/**
 * v4.4 的接缝是 412 半径上 20px 的描边，等比缩到 44px 球只剩约 1px，会被抗锯齿吃掉；
 * 按视觉取 1.75px（相对色盘半径 20.5 的圆心角），换算成 conic-gradient 的角度留白。
 */
const SEAM_PX = 1.75

/**
 * Angle (in degrees) taken by a seam of `SEAM_PX` on a disc of `ballPx` diameter.
 *
 * A FUNCTION, not a constant, because the ball's diameter is a user setting now
 * (F-018): the seam is a fixed number of CSS PIXELS, so its ANGLE has to shrink as
 * the disc grows. Pinning it to the 44px value would have made the seam look
 * progressively thinner on the large preset — invisible at 56px, where a
 * `1.75/20.5` ratio is `1.75/26.5` of the real radius. The visual weight is what
 * was tuned, so the pixel width is what stays fixed.
 */
export function seamDeg(ballPx: number = BALL_PX): number {
  const radius = Math.max(1, (ballPx - FRAME_PX * 2) / 2)
  return (SEAM_PX / radius) * (180 / Math.PI)
}

/** Kept for the modules that read it as a value (the 44px design case). */
const SEAM_DEG = seamDeg()

// Sector fills come from the shared palette, so a colour change reaches the ball
// and the panel together (D-030). This file used to keep its own copy.
// The palette is passed in rather than captured so the colour-blind variant
// (D-031) reaches the sectors too — the ball is the surface with no text
// fallback, so a missed swap there is exactly the case that matters.
const SEAM = 'var(--dsh-taskball-seam, #ffffff)'

/**
 * How many sector boundaries the animated gradient can express (F-010 / D-055).
 *
 * Option (b) needs a FIXED number of colour stops across the transition: a
 * conic-gradient can only interpolate when the old and new stop lists line up
 * one-to-one, so a "2 sectors → 1 sector" change cannot animate unless the
 * surplus boundary is still present at the old angle and simply slides away.
 * Eight covers every realistic ball (the ring divides 360° by the session
 * count, and past 8 sectors each one is under 45° wide on a 44px ball).
 *
 * Above this count the gradient degrades to the static one, which is correct
 * behaviour rather than a loss: the ring still shows every session.
 */
export const MAX_ANIMATED_BOUNDARIES = 8

/**
 * The boundary slots as CSS custom properties, registered with `<angle>` so the
 * browser can interpolate them (verified on this machine 2026-10-30:
 * `CSS.registerProperty({ syntax: '<angle>' })` works and a conic-gradient
 * reading the variable produced 24 distinct intermediate values over a
 * 0deg→90deg transition — i.e. the boundaries really slide, they do not cut).
 *
 * Names are stable and positional: slot i is the END of sector i. Slots past the
 * current sector count are pinned at 360deg so they contribute no visible stop
 * but still exist, which is what keeps the stop list length constant.
 */
export function boundaryVar(index: number): string {
  return `--taskball-b${index}`
}

/**
 * The seam half-width of boundary `index`, as a registered `<angle>`.
 *
 * The seam CANNOT stay a fixed expression inside the gradient string. A slot that
 * covers the whole circle — one sector, or the idle ring with no sectors at all —
 * has no boundary at 0deg/360deg, so a seam there paints a ~1.75px white wedge
 * across the top of an otherwise uniform disc. Measured 2026-10-30 on the real
 * page: the idle ball showed a vertical line at 12 o'clock.
 *
 * The static gradient already special-cased a full span (`span >= 359.9` → no
 * seam); the animated one could not, because branching in the string breaks
 * interpolation. Carrying the half-width as a variable keeps the string constant
 * AND lets it go to zero, so the seam can fade in as a boundary slides in.
 */
export function seamVar(index: number): string {
  return `--taskball-s${index}`
}

/**
 * Half-width of the seam at boundary `index`.
 *
 * Zero for a slot with no sector (pinned at 360deg, zero width) and for a slot
 * that spans the whole circle: neither has a real boundary to separate.
 */
export function seamAngleOf(
  slice: BallSlice | undefined,
  from: number,
  to: number,
  ballPx: number = BALL_PX,
): number {
  if (slice === undefined) return 0
  const span = to - from
  if (!(span > 0)) return 0
  if (span >= 359.9) return 0
  return seamHalfDeg(span, ballPx)
}

/**
 * The angle of boundary `index` (the END of sector `index`) for a given slice
 * list. A slot beyond the sector count is pinned to 360deg: the sector it would
 * close is zero-width, so it paints nothing, yet the stop count stays fixed.
 */
export function boundaryAngleOf(slices: readonly BallSlice[], index: number): number {
  if (index >= slices.length) return 360
  return slices[index]?.end ?? 360
}

const FRAME = 'linear-gradient(155deg, '
  + 'var(--dsh-taskball-frame-light, #fdfdfe) 0%, #f9fafc 34%, #eff2f7 66%, '
  + 'var(--dsh-taskball-frame-dark, #e6ebf2) 88%, #dfe5ee 100%)'

const SHEEN = 'radial-gradient(circle at 32% 26%, '
  + 'rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.06) 46%, rgba(255, 255, 255, 0) 62%)'

function seamHalfDeg(span: number, ballPx: number = BALL_PX): number {
  return Math.min(seamDeg(ballPx) / 2, span * 0.2)
}

export function ballGradient(
  slices: readonly BallSlice[],
  palette: Record<TaskballColor, string> = COLOR_HEX,
  ballPx: number = BALL_PX,
): string {
  const idle = `var(--dsh-taskball-idle, ${palette.gray})`
  const stops: string[] = []
  let cursor = 0
  for (const slice of slices) {
    const span = slice.end - slice.start
    if (!(span > 0)) continue
    // Clamped so overlapping or out-of-order input can never emit a descending
    // stop pair, which CSS resolves as an unintended hard edge.
    const start = Math.max(slice.start, cursor)
    if (start > cursor) stops.push(`${idle} ${cursor}deg ${start}deg`)
    if (span >= 359.9) {
      stops.push(`${palette[slice.color]} ${start}deg ${slice.end}deg`)
      cursor = slice.end
      continue
    }
    const half = seamHalfDeg(span, ballPx)
    stops.push(`${SEAM} ${start}deg ${start + half}deg`)
    stops.push(`${palette[slice.color]} ${start + half}deg ${slice.end - half}deg`)
    stops.push(`${SEAM} ${slice.end - half}deg ${slice.end}deg`)
    cursor = Math.max(cursor, slice.end)
  }
  if (stops.length === 0) return `conic-gradient(${idle} 0deg 360deg)`
  if (cursor < 360) stops.push(`${idle} ${cursor}deg 360deg`)
  return `conic-gradient(${stops.join(', ')})`
}

export function sectorColorVar(index: number): string {
  return `--taskball-c${index}`
}

/**
 * Register the animated slots once per document; safe to call repeatedly.
 *
 * TWO families are needed, not one: registering only `<angle>` would slide the
 * edges correctly but CUT on colour, because a slot's colour legitimately
 * changes when sectors shift (the red sector being swallowed must end up blue).
 * Registering `<color>` too is what lets that red→blue morph happen while the
 * edge slides.
 */
export function registerBoundaryProperties(target: typeof globalThis | undefined = globalThis): void {
  const css = (target as { CSS?: { registerProperty?: (rule: unknown) => void } } | undefined)?.CSS
  if (css?.registerProperty === undefined) return
  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    try {
      css.registerProperty({
        name: boundaryVar(index),
        syntax: '<angle>',
        inherits: false,
        initialValue: '360deg',
      })
    } catch {
      // Already registered (second activation, or an earlier build of this
      // sheet): re-registering throws, and that is not a failure.
    }
    try {
      css.registerProperty({
        name: sectorColorVar(index),
        syntax: '<color>',
        inherits: false,
        initialValue: 'transparent',
      })
    } catch {
      // Same as above.
    }
    // The seam width is a registered `<angle>` too, so it can go to zero as a
    // boundary slides in and back up when it slides out. A literal in the
    // gradient string could only be one fixed value (see `seamVar`).
    try {
      css.registerProperty({
        name: seamVar(index),
        syntax: '<angle>',
        inherits: false,
        initialValue: '0deg',
      })
    } catch {
      // Same as above.
    }
  }
}

/**
 * The CONSTANT gradient string used while animating (F-010 / D-055, option b).
 *
 * "Constant" is the whole trick: the browser only interpolates a conic-gradient
 * when the new stop list is structurally identical to the old one. So this
 * string never varies — it always emits `MAX_ANIMATED_BOUNDARIES` sectors, every
 * angle is a `calc()` over a registered `<angle>` variable, and every fill is a
 * registered `<color>` variable. Changing the ball's state then means changing
 * only variable VALUES, which CSS transitions.
 *
 * Slot `i` covers `[b(i-1), b(i)]`. Slots past the current sector count are
 * pinned at 360deg (zero width, so they paint nothing) yet still emitted, which
 * is what keeps the stop count fixed while an edge slides away.
 *
 * The seam is inset by the registered `--taskball-s<i>` instead of the literal
 * `min(SEAM_DEG/2, span * 0.2)` the first version used. That literal could not
 * tell a real boundary from one that is not there: with no sectors at all (the
 * idle ring) or with a single full-circle sector, slot 0 spans 0deg→360deg and
 * the seam drew a ~1.75px white wedge at 12 o'clock — the idle ball's vertical
 * line (measured 2026-10-30). `seamAngleOf` returns 0 for exactly those two
 * cases, and because it travels as a variable the gradient string stays constant
 * and the seam can still animate in.
 */
export function animatedBallGradient(palette: Record<TaskballColor, string> = COLOR_HEX): string {
  const idle = `var(--dsh-taskball-idle, ${palette.gray})`
  const stops: string[] = []
  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    const from = index === 0 ? '0deg' : `var(${boundaryVar(index - 1)}, 360deg)`
    const to = `var(${boundaryVar(index)}, 360deg)`
    const color = `var(${sectorColorVar(index)}, ${idle})`
    const half = `var(${seamVar(index)}, 0deg)`
    stops.push(`${SEAM} ${from} calc(${from} + ${half})`)
    stops.push(`${color} calc(${from} + ${half}) calc(${to} - ${half})`)
    stops.push(`${SEAM} calc(${to} - ${half}) ${to}`)
  }
  return `conic-gradient(${stops.join(', ')})`
}

/** The inline custom properties that place the current sectors in the slots. */
export function sectorVariables(
  slices: readonly BallSlice[],
  palette: Record<TaskballColor, string> = COLOR_HEX,
  ballPx: number = BALL_PX,
): Record<string, string> {
  const idle = palette.gray
  const variables: Record<string, string> = {}
  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    const slice = slices[index]
    const end = boundaryAngleOf(slices, index)
    const start = index === 0 ? 0 : boundaryAngleOf(slices, index - 1)
    variables[boundaryVar(index)] = `${end}deg`
    variables[sectorColorVar(index)] = slice === undefined ? idle : palette[slice.color]
    variables[seamVar(index)] = `${seamAngleOf(slice, start, end, ballPx)}deg`
  }
  return variables
}

export function ballStyle(
  slices: readonly BallSlice[],
  palette: Record<TaskballColor, string> = COLOR_HEX,
  ballPx: number = BALL_PX,
): Record<string, string> {
  return {
    // Layer order is paint order: the two padding-box layers must sit above the
    // border-box frame, or the opaque frame would cover the sectors entirely.
    background: `${SHEEN} padding-box, ${ballGradient(slices, palette, ballPx)} padding-box, ${FRAME} border-box`,
    border: `${FRAME_PX}px solid transparent`,
    borderRadius: '50%',
    // The host sets a global `corner-shape: superellipse(1.5)`, which renders
    // the radius above as a squircle rather than a circle. Every circular
    // surface has to opt back into a true round corner.
    cornerShape: 'round',
    boxShadow: 'inset 0 0 0 0.5px rgba(255, 255, 255, 0.5), '
      + '0 2px 6px rgba(15, 23, 42, 0.28), 0 1px 2px rgba(15, 23, 42, 0.22)',
    boxSizing: 'border-box',
  }
}

/**
 * The animated ball's inline style (F-010 / D-055, option b).
 *
 * Differs from `ballStyle` in exactly two ways, both required for interpolation:
 * the gradient is the CONSTANT `animatedBallGradient` (never rebuilt from the
 * current slices), and the current state arrives as custom-property values that
 * the stylesheet transitions. Everything else — frame, sheen, corner-shape,
 * border — is shared with the static style so an animating ball is visually
 * identical to a resting one.
 */
export function animatedBallStyle(
  slices: readonly BallSlice[],
  palette: Record<TaskballColor, string> = COLOR_HEX,
  ballPx: number = BALL_PX,
): Record<string, string> {
  return {
    ...sectorVariables(slices, palette, ballPx),
    background: `${SHEEN} padding-box, ${animatedBallGradient(palette)} padding-box, ${FRAME} border-box`,
    border: `${FRAME_PX}px solid transparent`,
    borderRadius: '50%',
    cornerShape: 'round',
    boxShadow: 'inset 0 0 0 0.5px rgba(255, 255, 255, 0.5), '
      + '0 2px 6px rgba(15, 23, 42, 0.28), 0 1px 2px rgba(15, 23, 42, 0.22)',
    boxSizing: 'border-box',
  }
}

/**
 * Whether this slice list is expressible in the fixed slots.
 *
 * Above `MAX_ANIMATED_BOUNDARIES` sectors the animated string cannot represent
 * the ring (there are more boundaries than slots), so the caller falls back to
 * the static gradient. The ring still shows every session — it just cuts instead
 * of sliding, which is the honest trade for a ball that would otherwise drop
 * sectors.
 */
export function canAnimateSlices(slices: readonly BallSlice[]): boolean {
  return slices.length <= MAX_ANIMATED_BOUNDARIES
}

/**
 * Diameter of the glass disc at the ball's centre, in CSS px.
 *
 * Derived from the ball's diameter so the disc scales with the presets (F-018 /
 * D-072). Kept as a function with the design size as its default, so the 44px
 * case stays exactly 16px and every existing caller that passes nothing keeps
 * the v4.4 measurement.
 */
export function centerPx(ballPx: number = BALL_PX): number {
  return Math.round(ballPx * CENTER_RATIO * 100) / 100
}

export function ballCenterStyle(ballPx: number = BALL_PX): Record<string, string> {
  const size = centerPx(ballPx)
  const offset = -size / 2
  return {
    // 玻璃心留一点透明度，让底下扇形的颜色透上来——v4.4 的磨砂盘本来就是透色的；
    // 但小尺寸上再透就只剩一个糊点，所以最低档停在 0.34。
    background: 'radial-gradient(circle at 34% 26%, '
      + 'rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.52) 52%, rgba(255, 255, 255, 0.34) 100%)',
    backdropFilter: 'blur(2px)',
    WebkitBackdropFilter: 'blur(2px)',
    border: '0.5px solid rgba(255, 255, 255, 0.55)',
    borderRadius: '50%',
    cornerShape: 'round',
    boxShadow: 'inset 0 1px 2px rgba(255, 255, 255, 0.85), '
      + 'inset 0 -1px 2px rgba(146, 154, 166, 0.28), 0 1px 2px rgba(15, 23, 42, 0.18)',
    boxSizing: 'border-box',
    height: `${size}px`,
    left: '50%',
    marginLeft: `${offset}px`,
    marginTop: `${offset}px`,
    pointerEvents: 'none',
    position: 'absolute',
    top: '50%',
    width: `${size}px`,
  }
}
