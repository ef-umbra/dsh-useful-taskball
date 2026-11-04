import * as React from 'react'

const h = React.createElement

/**
 * One path of an inlined host glyph. A bare string is the common case; the
 * object form exists because the gear's outline needs its own `strokeMiterlimit`
 * (see `GEAR_ICON_PATHS`).
 */
type IconPath = string | { readonly d: string; readonly miterlimit: number }

/** Regular weight in the host's own scale (`Icon*OutlineRegular`). */
const ICON_STROKE = 1
/** Medium weight (`Icon*OutlineMedium`), which is what the header controls use. */
const ICON_STROKE_MEDIUM = 1.3

/**
 * The host's own glyphs, inlined (user, 2026-10-31: option B).
 *
 * WHY INLINED AND NOT `require`d: the host ships these as
 * `IconFolderCloseRegular` / `IconQueueOutlineRegular` from
 * `@deepseek-ai/dsh-client-ui-primitives`, which is a PLATFORM SEED MODULE in the
 * browser runtime (`dsh-web-frontend`'s `staticModules` table) and is NOT an
 * installable package — nothing on disk provides it as a dependency. Reaching it
 * would mean widening this plugin's require shim (`client-shell.cjs`) and its
 * bundle-purity gate past `react`, trading a build-time guarantee for two icons.
 * The geometry below is copied verbatim from the host bundle (viewBox 0 0 16 16,
 * strokeWidth 1), so the result is pixel-identical to the sidebar's own rows
 * while adding no dependency at all.
 *
 * WHY THESE TWO (user, 2026-10-31):
 * - `folder` — the sidebar's workspace glyph. A draft row on a session that
 *   belongs to a workspace but has never been sent reads as "an empty workspace
 *   conversation".
 * - `queue` — the host's "All conversations (show archived)" glyph (the
 *   `viewOptions.showArchived` entry under 筛选会话). A draft row on a session
 *   that already has turns behind it reads as "an existing conversation".
 *
 * Together they remove the ambiguity the user reported: a draft list mixing a
 * brand-new workspace conversation with a long-lived one looked like two rows of
 * the same kind.
 *
 * COST: neither follows a host redesign. If the host changes either glyph, these
 * copies diverge silently — acceptable for a 13px affordance, recorded in
 * `docs/compatibility.md`.
 */
export const FOLDER_ICON_PATHS: readonly string[] = [
  'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
  'M3.63501 7.66614H12.3647',
]

export const QUEUE_ICON_PATHS: readonly string[] = [
  'M5 6.75H11',
  'M5 9H8',
  'M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334',
]

/**
 * The panel header's two controls, same geometry as the host's account menu
 * (`IconSettingsOutlineMedium` / `IconCloseOutlineMedium`, user 2026-11-03).
 *
 * WHY THESE AND NOT `'⚙'` / `'×'`: those were text characters, so their weight
 * and size came from the font fallback chain — a different system, a different
 * font pack or a skin changed how the two buttons looked, and the pair only
 * matched by accident (both were text). The host's own glyphs are fixed
 * geometry, so the pair stays a pair.
 *
 * WHY BOTH: swapping only the gear would leave a thin SVG next to a font `×` —
 * the exact "these two don't look like one control group" problem the change is
 * meant to fix (user 2026-11-03: 「两个都换吧」).
 *
 * The gear's outline path carries `strokeMiterlimit: 10` in the host; without it
 * the sharp concave corners fall back to the default miter limit of 4 and bevel.
 */
export const GEAR_ICON_PATHS: readonly IconPath[] = [
  'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z',
  {
    d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z',
    miterlimit: 10,
  },
]

export const CLOSE_ICON_PATHS: readonly IconPath[] = [
  'M2.5 2.5L13.5 13.5',
  'M13.5 2.5L2.5 13.5',
]

/**
 * One inlined host glyph, sized and coloured like the panel's own text.
 *
 * `aria-hidden` on purpose: the icon only repeats what the row's title already
 * says, so it must not become a second thing for a screen reader to announce.
 *
 * `strokeWidth` is in VIEWBOX units, not device pixels: at `size: 13` a value of
 * 1.3 renders 1.3 × 13/16 ≈ 1.06 px. Passing the host's own 1.3 is therefore
 * already "scaled down proportionally" — the ratio to the disc is what matters,
 * and dividing by 13/16 here would double-compensate.
 */
export function HostIcon(
  props: {
    readonly paths: readonly IconPath[]
    readonly size?: number
    readonly color?: string
    readonly strokeWidth?: number
  },
): React.ReactElement {
  const size = props.size ?? 13
  return h('svg', {
    'aria-hidden': true,
    fill: 'none',
    height: size,
    stroke: props.color ?? 'currentColor',
    strokeWidth: props.strokeWidth ?? ICON_STROKE,
    style: { flex: 'none' },
    viewBox: '0 0 16 16',
    width: size,
    xmlns: 'http://www.w3.org/2000/svg',
  }, ...props.paths.map((path, index) => {
    const d = typeof path === 'string' ? path : path.d
    const miterlimit = typeof path === 'string' ? undefined : path.miterlimit
    return h('path', {
      d,
      key: index,
      ...(miterlimit === undefined ? {} : { strokeMiterlimit: miterlimit }),
    })
  }))
}

/** The two header controls, at the panel's own 13px text size. */
export function gearIcon(): React.ReactElement {
  return HostIcon({ paths: GEAR_ICON_PATHS, strokeWidth: ICON_STROKE_MEDIUM })
}

/** Same weight as the gear on purpose: they sit side by side as one control group. */
export function closeIcon(): React.ReactElement {
  return HostIcon({ paths: CLOSE_ICON_PATHS, strokeWidth: ICON_STROKE_MEDIUM })
}

/**
 * The glyph for a draft row: folder for a workspace's new conversation, queue
 * (a chat bubble) for one that already has turns behind it.
 */
export function draftIcon(newConversation: boolean, size = 13): React.ReactElement {
  return HostIcon({ paths: newConversation ? FOLDER_ICON_PATHS : QUEUE_ICON_PATHS, size, strokeWidth: ICON_STROKE })
}
