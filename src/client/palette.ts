import type { TaskballColor } from './model.js'

/**
 * The plugin's status palette — the ONE place a status colour is defined.
 *
 * Two surfaces paint status colours: the panel's rows/dots/checkbox and the
 * ball's conic-gradient sectors. They used to keep separate copies of the same
 * literal hex values (`panel.ts` and `ball-visual.ts`), which meant any change
 * to a colour silently applied to only one of them — and the ball is exactly
 * the surface with no text fallback, so a half-applied change hits the users
 * who need it most. Everything now reads this module.
 */
export const COLOR_HEX: Record<TaskballColor, string> = {
  red: '#f16662',
  yellow: '#ffac50',
  blue: '#52a7ff',
  green: '#47d489',
  gray: '#c3ccd9',
}

/**
 * Text colour that stays readable on each status fill. The fills are the v4.4
 * palette (light, saturated), so dark ink wins on all four; only the dark
 * theme's red needs a lift to keep contrast on its own tint.
 */
export const COLOR_INK: Record<TaskballColor, string> = {
  red: '#5c1210',
  yellow: '#5a3606',
  blue: '#0a2f56',
  green: '#0b3d24',
  gray: '#3c4553',
}

/**
 * Colour-blind variant of the palette (D-031).
 *
 * Red-green colour vision deficiency (deuteranopia/protanopia, ~8% of men)
 * collapses the red and green hue channels onto one yellow-brown axis, so the
 * default red and green separate by only **60** in simulated RGB distance —
 * effectively the same colour, on the two statuses that matter most ("failed"
 * vs "done"). Deepening one or lightening the other does not help: the axis
 * itself is what collapsed.
 *
 * The fix is to stop using red and green for those two states and lean on
 * luminance, which stays intact:
 *
 *   failed  #d94f7a  magenta — simulated distance 140 from blue
 *   done    #0fb9b1  teal    — simulated distance  75 from blue
 *
 * Worst pair among the four statuses rises 60 → 66 (`done` vs `yellow` is the
 * tightest at 66; `failed` vs `done` goes 60 → 66 as well), and both fill/ink
 * pairs clear WCAG AA: 4.55 for magenta, 7.31 for teal.
 *
 * Yellow and blue are unchanged on purpose: they already sit far from both
 * replacements in simulated space (≥116 and ≥75).
 */
export const COLOR_HEX_CB: Record<TaskballColor, string> = {
  red: '#d94f7a',
  yellow: '#ffac50',
  blue: '#52a7ff',
  green: '#0fb9b1',
  gray: '#c3ccd9',
}

/** Ink for the colour-blind fills. Both are near-black; the magenta fill needs
 *  the darker of the two to clear WCAG AA (4.22 → 4.62). */
export const COLOR_INK_CB: Record<TaskballColor, string> = {
  red: '#2b0a16',
  yellow: '#5a3606',
  blue: '#0a2f56',
  green: '#06283d',
  gray: '#3c4553',
}

export interface Palette {
  readonly hex: Record<TaskballColor, string>
  readonly ink: Record<TaskballColor, string>
}

export const DEFAULT_PALETTE: Palette = { hex: COLOR_HEX, ink: COLOR_INK }
export const COLOR_BLIND_PALETTE: Palette = { hex: COLOR_HEX_CB, ink: COLOR_INK_CB }

/** Pick the palette for a setting value; anything unknown falls back to default. */
export function paletteFor(colorBlindMode: boolean | undefined): Palette {
  return colorBlindMode === true ? COLOR_BLIND_PALETTE : DEFAULT_PALETTE
}

/**
 * A soft version of a status colour for whole-row tinting: the solid fills are
 * too loud to sit behind every row, and a tint keeps the row's normal ink
 * readable in both themes without needing a per-colour ink swap.
 */
export function tintOf(color: TaskballColor, palette: Palette = DEFAULT_PALETTE): string {
  const hex = palette.hex[color]
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${red}, ${green}, ${blue}, 0.16)`
}
