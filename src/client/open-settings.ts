/**
 * Open this plugin's own configuration page (F-009's "open all settings").
 *
 * WHERE THE PAGE ACTUALLY LIVES — measured on the real page, 2026-10-29:
 * this plugin registers into `plugins.bundle.config`, and that slot is a CHILD of
 * the `main` slot's `plugins` key (the plugin manager's central panel). It is NOT
 * inside the Settings dialog: opening Settings and selecting 内置插件 / 插件管理
 * shows the plugin INVENTORY and the super-injector, never this bundle's page.
 *
 * The first implementation navigated the settings dialog. It "worked" — a dialog
 * opened — while landing somewhere else entirely, which is the worst kind of
 * failure because it looks like success.
 *
 * ROUTE: select the central panel, then write the manager's own view state.
 * Both are the exact state changes the sidebar launcher and the plugin page make.
 *
 * `layout.selectPanel` MUST be called as a METHOD on the service object —
 * `LayoutController.selectPanel` reads `this.hasMainPanel`. Extracting it into a
 * local (`const { selectPanel } = layout`) throws
 * `Cannot read properties of undefined (reading 'hasMainPanel')`, and React
 * swallows an exception thrown inside an `onClick`, so the button looked inert
 * with nothing in the console. That was measured by invoking the handler from
 * the React fiber, after `.click()` and a real mouse click both produced silence.
 */

/** The package name this plugin's configuration page is keyed by. */
export const PACKAGE_NAME = 'dsh-useful-taskball'
/** Key of the central panel that hosts plugin configuration pages. */
const PLUGINS_PANEL_ID = 'plugins'
/** The keyed slot those central panels register into. */
const MAIN_SLOT = 'main'

export interface SlotEntryLike {
  readonly options?: { readonly key?: unknown; readonly id?: unknown }
  readonly store?: { create?: () => unknown }
}

export interface SlotsLike {
  entries?(key: string): readonly SlotEntryLike[]
}

interface PluginManagerNavigation {
  readonly actions?: { readonly setView?: (view: { kind: string; name: string }) => void }
}

export interface LayoutLike {
  /** Method on the service: call it as `layout.selectPanel(id)`, never detached. */
  readonly selectPanel?: (panelId: string | null) => void
}

export interface OpenSettingsPorts {
  readonly slots?: SlotsLike | undefined
  /** `ctx.layout`; OPTIONAL service, read through `ctx.get`. */
  readonly layout?: LayoutLike | undefined
}

/**
 * The plugin manager's live navigation store, or undefined when this host has no
 * plugin manager panel (a headless profile, or a UI that predates it).
 */
export function pluginManagerNavigation(slots: SlotsLike | undefined): PluginManagerNavigation | undefined {
  try {
    const entry = slots?.entries?.(MAIN_SLOT)?.find((candidate) => candidate.options?.key === PLUGINS_PANEL_ID)
    const instance = typeof entry?.store?.create === 'function' ? entry.store.create() : undefined
    const candidate = instance as PluginManagerNavigation | undefined
    return typeof candidate?.actions?.setView === 'function' ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Open this bundle's configuration page.
 *
 * @returns whether the route was available, so the caller can hide a control
 *   that could not reach the page.
 */
export function openPluginSettings(ports: OpenSettingsPorts): boolean {
  const layout = ports.layout
  if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') {
    noteSettingsRouteFailure('layout service is absent or has no selectPanel')
    return false
  }
  const navigation = pluginManagerNavigation(ports.slots)
  if (navigation === undefined) {
    noteSettingsRouteFailure('plugin-manager navigation store not found in the main slot')
    return false
  }
  // Two writes, in this order: the panel must be selected for its page to mount
  // at all, and its view state survives that, so a cold open still lands on the
  // bundle page instead of the list. Both go through the service OBJECT — see
  // the module comment on why a detached method reference throws.
  layout.selectPanel(PLUGINS_PANEL_ID)
  navigation.actions?.setView?.({ kind: 'package', name: PACKAGE_NAME })
  return true
}

/**
 * Why the last "open all settings" attempt failed, on the window.
 *
 * The same reasoning as `__taskballDeriveFailures`: a button that silently does
 * nothing is the hardest kind of defect to report, and this route depends on an
 * OPTIONAL service plus another plugin's panel. Reading the reason from the
 * console beats guessing at which half was missing. Kept to the last few.
 */
export interface SettingsRouteFailure {
  readonly at: number
  readonly reason: string
}

export function noteSettingsRouteFailure(reason: string): void {
  const scope = globalThis as { __taskballSettingsRoute?: SettingsRouteFailure[] }
  const list = scope.__taskballSettingsRoute ?? []
  scope.__taskballSettingsRoute = [...list, { at: Date.now(), reason }].slice(-5)
  console.warn(`[taskball] open all settings failed: ${reason}`)
}
