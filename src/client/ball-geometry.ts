/**
 * The ball's geometry constants — ONE owner.
 *
 * Why this file exists at all: the ball's diameter used to be written as the
 * literal `44` in five separate places (`ball.ts`, `ball-visual.ts`, `quick.ts`,
 * and twice in `panel.ts`). Every one of them is an ANCHOR calculation — where the
 * panel opens, where the quick popup fits, how much of the ring the seam eats — so
 * a ball that changes size while those copies stay behind would place the panel
 * and the popup off-target, which reads as "the plugin is broken", not "the
 * numbers disagree".
 *
 * It is a separate module rather than a constant on `ball.ts` because
 * `ball-visual.ts` needs it too, and `ball.ts` already imports `ball-visual.ts`:
 * exporting it from `ball.ts` would make the ring's pure geometry depend on the
 * React component module and close an import cycle.
 *
 * NOTHING else belongs here. Colours are `palette.ts`; layout of the panel's rows
 * is `panel.ts`. This file is only "how big is the ball".
 */

/**
 * Diameter of the ball, in CSS px — the `medium` preset and the fallback.
 *
 * 44 is the v4.4 design value: the ring's seam width (`SEAM_PX` in
 * `ball-visual.ts`) was tuned against it, so a different size needs that seam
 * recomputed proportionally rather than copied.
 */
export const BALL_SIZE = 44

/** The three presets and their diameters (F-018). Mirrors the Host's config enum. */
export const BALL_SIZE_BY_PRESET = { small: 36, medium: 44, large: 56 } as const
export type BallSizePreset = keyof typeof BALL_SIZE_BY_PRESET
export const DEFAULT_BALL_SIZE_PRESET: BallSizePreset = 'medium'

/**
 * Resolve a preset name to pixels, degrading to the default on anything unknown.
 *
 * The value crosses a service boundary (Host config → Client), and an older Host,
 * a hand-edited profile patch, or a future renamed preset would otherwise make the
 * ball render at `NaN` px — an invisible ball with no console error, which is the
 * hardest class of bug to report. Unknown input therefore means "the design value".
 */
export function ballSizePx(preset: string | undefined): number {
  if (preset !== undefined && Object.hasOwn(BALL_SIZE_BY_PRESET, preset)) {
    return BALL_SIZE_BY_PRESET[preset as BallSizePreset]
  }
  return BALL_SIZE
}
