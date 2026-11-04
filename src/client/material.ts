/**
 * The host's own menu material, in one place.
 *
 * Two surfaces wear it: the task panel when `panelFrosted` is on (F-002 / D-039)
 * and the quick settings popup always (F-009). They sit next to each other — the
 * popup is anchored to the same ball — so two hand-rolled blurs would read as a
 * rendering bug the moment both are inspected side by side. Both read these two
 * tokens and nothing else.
 *
 * `--dsw-menu-backdrop-filter` and `--dsw-specific-menu` are the host's menu
 * material: the filter carries the saturate() that keeps blurred text from going
 * grey, and the fill is already theme-aware (light/dark are different values of
 * the SAME token), so no per-theme branch belongs here.
 */
export const MENU_BACKDROP_FILTER = 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))'
export const MENU_SURFACE_FILL = 'var(--dsw-specific-menu, rgba(30, 41, 59, 0.72))'

/** The blur as a style fragment; empty while frosting is off. */
export function frostedFilter(enabled: boolean): { backdropFilter?: string } {
  return enabled ? { backdropFilter: MENU_BACKDROP_FILTER } : {}
}
