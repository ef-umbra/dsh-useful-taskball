import z from '@deepseek-ai/schemastery'
import { createVolatile, type Volatile } from '@deepseek-ai/cosmokit'

export const DEFAULT_COMPLETION_RETENTION_MINUTES = 30
export const DEFAULT_BUBBLE_DURATION_MS = 2000
export const DEFAULT_FONT_SIZE_PX = 13

/**
 * Panel background alpha, in percent (F-002 / D-039).
 *
 * 30 + frosted is the default since D-075 (user 2026-11-02: 「磨砂加不透明度 30，
 * 其实这样比较好看，磨砂不会导致很透，而是挺好看的，也可以反映主题颜色」).
 *
 * Why this combination rather than a higher alpha: the blur is what carries the
 * material, and at 30% the panel still shows the host's own colour underneath —
 * so a themed or skinned DSH tints the panel for free. Raising the alpha towards
 * 100 makes the blur invisible (that was the original defect D-039 fixed by
 * capping at 72), so the two settings are not independent: frost needs a low
 * alpha to be visible at all.
 *
 * 100 remains reachable for anyone who wants the old fully-solid look; the
 * `alpha >= PANEL_ALPHA_MAX` branch in `panel.ts` still resolves to the plain
 * host token with no `color-mix` layer.
 */
export const DEFAULT_PANEL_OPACITY = 30
export const PANEL_OPACITY_MIN = 30
export const PANEL_OPACITY_MAX = 100
/**
 * Alpha ceiling while frosted. The blur can only show what the background lets
 * through, so a 100%-opaque frosted panel would look unchanged. With the default
 * now at 30 this ceiling is mostly a guard for users who raise the slider while
 * frosted: anything above it would quietly stop looking frosted.
 */
export const FROSTED_ALPHA_CAP = 72

/** Panel text sizes offered to the user; `host` means "follow the app setting". */
export const FONT_SIZE_MIN_PX = 10
export const FONT_SIZE_MAX_PX = 24

/** How a folded row leaves the list (D-026). */
export const FOLD_ANIMATIONS = ['slide-out', 'slide-down'] as const
export type FoldAnimation = typeof FOLD_ANIMATIONS[number]

/**
 * How a row states its status colour. Cut to two on 2026-11-03 (user: 「只保留色条
 * 和圆点，其他的不要了」) — the four whole-row modes are gone, and the former
 * `bar` was renamed `rect` because it is a small rectangle, not a bar.
 *
 * The schema ACCEPTS the legacy names so an existing profile still loads: Host
 * config validation runs at plugin load, and a schema that rejected `bar` failed
 * the whole entry (`ValidationError: $.statusMarker expected "rect" | "dot" but
 * got "bar"`, 0.10.1). Mapping to a surviving marker happens on the Client, in
 * `statusMarkerOf` — deliberately NOT here.
 *
 * Why not `z.transform` (which would migrate inside the schema): the settings
 * layer serialises this schema to JSON and rehydrates it on the Client to
 * re-validate the value before marking a form `ready`. A transform's `callback`
 * survives `JSON.stringify` as a STRING, so the rehydrated node throws
 * `callback is not a function`, `decode` yields undefined, the form stays
 * `loading` forever and settings cannot be saved at all (measured 2026-11-03).
 * A pure union is plain data and round-trips losslessly.
 */
export const LEGACY_STATUS_MARKERS = ['bar', 'row-solid', 'row-tint', 'row-box', 'row-tint-outline'] as const
export const STATUS_MARKERS = ['rect', 'dot'] as const
export type StatusMarker = typeof STATUS_MARKERS[number]

/** Every value the schema accepts; only the two in STATUS_MARKERS are renderable. */
export const ACCEPTED_STATUS_MARKERS = [...STATUS_MARKERS, ...LEGACY_STATUS_MARKERS] as const

export const DEFAULT_FOLD_ANIMATION: FoldAnimation = 'slide-out'
export const DEFAULT_STATUS_MARKER: StatusMarker = 'rect'

/**
 * Ball diameter presets (F-018).
 *
 * Presets rather than a free number on purpose: every settings write is a
 * plugin-entry reload measured at 1–2.7 s (D-046), so a slider that emits a value
 * per pixel would reload the plugin dozens of times while the user drags. Three
 * stops make the cost a single reload per deliberate choice.
 *
 * The values are not arbitrary: `SEAM_PX = 1.75` in `ball-visual.ts` was tuned
 * against a 44px disc, so the seam is recomputed from whatever size is active
 * rather than copied (see `ball-geometry.ts`).
 */
export const BALL_SIZES = ['small', 'medium', 'large'] as const
export type BallSize = typeof BALL_SIZES[number]
export const DEFAULT_BALL_SIZE: BallSize = 'medium'

/**
 * How close a release must be to a snap line for the ball to stick, in CSS px
 * (F-019). **0 turns snapping off** — the user asked for that range explicitly
 * (2026-11-01), and it is what makes "off" reachable without a separate switch.
 *
 * Upper bound is 48: beyond that a ball released anywhere near the middle of the
 * window would jump to an edge, which is indistinguishable from "the ball flies
 * away on its own".
 */
export const DEFAULT_SNAP_DISTANCE = 16
export const SNAP_DISTANCE_MIN = 0
export const SNAP_DISTANCE_MAX = 48

// `.volatile()` is required, not cosmetic: the settings service only exposes a
// namespace whose Config schema has at least one volatile field, so a plain
// schema makes the bundle's page render "settings unavailable".
export const Config = z.object({
  completionRetentionMinutes: z.number().min(1).default(DEFAULT_COMPLETION_RETENTION_MINUTES).volatile(),
  bubbleDurationMs: z.number().min(100).default(DEFAULT_BUBBLE_DURATION_MS).volatile(),
  /**
   * Master switch for ALL state-change bubbles (user 2026-11-03: 让「完成时提醒」
   * 覆盖所有状态转换的气泡弹出). Was completion-only; now it also silences the
   * blue→red and blue→yellow bubbles that used to be unconditional.
   *
   * Default flipped to `true` at the same time: as a completion-only flag, `false`
   * meant "you only miss the quiet one", but as a master switch it would mean a
   * fresh install shows NO bubble at all — not even a failure (D-002).
   */
  bubbleOnCompletion: z.boolean().default(true).volatile(),
  showFoldedCount: z.boolean().default(true).volatile(),
  /** Hides the whole "handled" section, not just its badge (D-026). */
  showFoldedSection: z.boolean().default(true).volatile(),
  /** Clicking anywhere outside the panel closes it (F-003 / D-035). */
  closeOnOutsideClick: z.boolean().default(true).volatile(),
  /**
   * Panel background alpha in percent (F-002 / D-075). Defaults to the minimum
   * because it now ships together with frosting: 30% lets the host's own colour
   * show through the blur, which is the look the user picked. 100 is still
   * available and resolves to the plain token with no `color-mix` layer.
   */
  panelOpacity: z.number().min(PANEL_OPACITY_MIN).max(PANEL_OPACITY_MAX).default(DEFAULT_PANEL_OPACITY).volatile(),
  /**
   * Frosted-glass panel: the host's own menu material (`--dsw-menu-backdrop-filter`
   * plus the translucent menu fill). ON by default since D-075 — it is what makes
   * the 30% default look like material rather than a washed-out box, and it is
   * what lets a themed/skinned host tint the panel. The alpha cap still applies
   * while this is on (F-002 / D-039).
   */
  panelFrosted: z.boolean().default(true).volatile(),
  foldAnimation: z.union([z.const('slide-out'), z.const('slide-down')]).default(DEFAULT_FOLD_ANIMATION).volatile(),
  statusMarker: z.union(ACCEPTED_STATUS_MARKERS.map((value) => z.const(value))).default(DEFAULT_STATUS_MARKER).volatile(),
  /**
   * Swaps the red/green fills for a magenta/teal pair that stays distinguishable
   * under red-green colour vision deficiency (D-031). Off by default: the
   * default palette is the one the design was made for.
   */
  colorBlindMode: z.boolean().default(false).volatile(),
  /**
   * `host` inherits the app's own content font size, which is the default
   * because the panel should look like part of the UI. `custom` opts into an
   * explicit px size for users who want the ball's panel larger or smaller.
   */
  fontSizeMode: z.union([z.const('host'), z.const('custom')]).default('host').volatile(),
  fontSizePx: z.number().min(FONT_SIZE_MIN_PX).max(FONT_SIZE_MAX_PX).default(DEFAULT_FONT_SIZE_PX).volatile(),
  /**
   * Ball diameter preset (F-018). Affects only the ball: the panel and the bubble
   * keep their own sizes and merely re-anchor against the new diameter (user
   * 2026-11-01: 「只需要修改球的大小，不需要修改面板的大小，气泡也不用」).
   */
  ballSize: z.union([z.const('small'), z.const('medium'), z.const('large')]).default(DEFAULT_BALL_SIZE).volatile(),
  /**
   * Snap reach in CSS px (F-019). 0 disables snapping; 16 is the value every
   * version before this one hard-coded.
   */
  snapDistance: z.number().min(SNAP_DISTANCE_MIN).max(SNAP_DISTANCE_MAX).default(DEFAULT_SNAP_DISTANCE).volatile(),
})

export interface TaskballConfig {
  completionRetentionMinutes: Volatile<number | undefined>
  bubbleDurationMs: Volatile<number | undefined>
  bubbleOnCompletion: Volatile<boolean | undefined>
  showFoldedCount: Volatile<boolean | undefined>
  showFoldedSection: Volatile<boolean | undefined>
  closeOnOutsideClick: Volatile<boolean | undefined>
  panelOpacity: Volatile<number | undefined>
  panelFrosted: Volatile<boolean | undefined>
  foldAnimation: Volatile<FoldAnimation | undefined>
  statusMarker: Volatile<StatusMarker | undefined>
  colorBlindMode: Volatile<boolean | undefined>
  fontSizeMode: Volatile<'host' | 'custom' | undefined>
  fontSizePx: Volatile<number | undefined>
  ballSize: Volatile<BallSize | undefined>
  snapDistance: Volatile<number | undefined>
}

/** Detached defaults used when the plugin is constructed without a patch config. */
export function defaultConfig(): TaskballConfig {
  return {
    bubbleDurationMs: createVolatile<number | undefined>(DEFAULT_BUBBLE_DURATION_MS),
    bubbleOnCompletion: createVolatile<boolean | undefined>(true),
    colorBlindMode: createVolatile<boolean | undefined>(false),
    closeOnOutsideClick: createVolatile<boolean | undefined>(true),
    completionRetentionMinutes: createVolatile<number | undefined>(DEFAULT_COMPLETION_RETENTION_MINUTES),
    foldAnimation: createVolatile<FoldAnimation | undefined>(DEFAULT_FOLD_ANIMATION),
    fontSizeMode: createVolatile<'host' | 'custom' | undefined>('host'),
    fontSizePx: createVolatile<number | undefined>(DEFAULT_FONT_SIZE_PX),
    panelFrosted: createVolatile<boolean | undefined>(true),
    panelOpacity: createVolatile<number | undefined>(DEFAULT_PANEL_OPACITY),
    showFoldedCount: createVolatile<boolean | undefined>(true),
    showFoldedSection: createVolatile<boolean | undefined>(true),
    statusMarker: createVolatile<StatusMarker | undefined>(DEFAULT_STATUS_MARKER),
    ballSize: createVolatile<BallSize | undefined>(DEFAULT_BALL_SIZE),
    snapDistance: createVolatile<number | undefined>(DEFAULT_SNAP_DISTANCE),
  }
}
