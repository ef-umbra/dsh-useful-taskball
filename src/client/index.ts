import * as React from 'react'
import { TaskballPanel, exitDurationMs, needsRedConfirm, panelPlacement, type TaskballPanelProps } from './panel.js'
import { TaskballQuick, quickPlacement, type QuickValues } from './quick.js'
import { openPluginSettings, pluginManagerNavigation, type LayoutLike, type SlotsLike } from './open-settings.js'
import { FIELDS, TaskballSettings } from './settings.js'
import {
  WRITE_DELAY_MS,
  createSettingsWriter,
  settingsWriterFor,
  useSettings,
  type SettingsForm,
} from './settings-writer.js'
import { TaskballBall, TaskballBubble, BUBBLE_OUTLINE_PX, DRAG_THRESHOLD_PX, SNAP_DISTANCE, TAIL, bubbleSide, bubbleTop, clampPosition, followAttachment, isOwnSurface, readCenterColumn, readComposerCard, readPlacement, snapPosition, snapTargets, stripBox, stripGutterBudget, transitionsOf, writePlacement, type BallPosition, type StripBox } from './ball.js'
import { BALL_SIZE, ballSizePx } from './ball-geometry.js'
import { COLLAPSED_KEY, MIN_SEAM_SEGMENT_PX, SEAM_PX, STRIP_GAP, STRIP_HEIGHT, STRIP_WIDTH, TaskballStrip, readCollapsed, writeCollapsed, seamsVisible, segmentHeight, stripSegments } from './ball-strip.js'
import { injectStyle } from './style.js'
import { MAX_ANIMATED_BOUNDARIES, animatedBallGradient, canAnimateSlices, registerBoundaryProperties, sectorVariables, seamAngleOf, seamVar } from './ball-visual.js'
import { paletteFor } from './palette.js'
import {
  COLOR_BLIND_PALETTE,
  COLOR_HEX,
  COLOR_HEX_CB,
  COLOR_INK,
  COLOR_INK_CB,
  DEFAULT_PALETTE,
  tintOf,
} from './palette.js'
import { HOST_READY_GRACE_MS, createHostWriter, useHostState, useNow } from './host-state.js'
import { useDraftIds, DRAFT_KEY_PREFIX, DRAFT_POLL_MS, hasDraftContent, readDraftIds, NO_DRAFT_IDS } from './drafts.js'
import type { FoldAnimation, StatusMarker } from './panel.js'
import {
  DEFAULT_POLL_MS,
  EMPTY_WITNESSES,
  FOLD_RECONCILE_MS,
  classifyStatus,
  deriveView,
  flightWindowMs,
  noteRunning,
  orderEntries,
  overriddenFolds,
  pruneFoldOverrides,
  pruneWitnesses,
  sectorAngles,
  sectorEntries,
  taskEntries,
  type FlightWitnesses,
  type FoldOverride,
  type TaskballColor,
  type TaskballSession,
  type TaskballStatus,
  type TaskballWorkspace,
} from './model.js'
// The string tables are their own module; `index.ts` still owns the single
// `locale.register` call that installs them.
import { en, zh } from './locale.js'

export { en, zh }

const h = React.createElement

/**
 * Every surface that counts as "inside" for the one outside-click listener.
 * A single list on purpose: with two lists the two overlay layers disagree the
 * moment one of them gains an element (AGENTS.md §2.11).
 */
const INSIDE_SELECTOR = '[data-taskball-panel], [data-taskball-ball], [data-taskball-bubble], [data-taskball-quick], [data-taskball-strip]'

/** Stable fallbacks: a fresh object per call breaks `useSyncExternalStore`. */
const STATUS_MARKER_VALUES: readonly StatusMarker[] = ['rect', 'dot']

/**
 * Map a stored value onto the two markers that still exist (2026-11-03).
 *
 * The Host schema ACCEPTS the legacy names (`bar` and the four retired whole-row
 * modes) so an old profile still loads, but only these two render. The mapping
 * must live HERE rather than in the schema: a `z.transform` callback is lost when
 * the settings layer serialises the schema to JSON for the Client, which left the
 * form stuck at `loading` and made every settings write fail (measured 2026-11-03).
 *
 * `bar` becomes `rect` (same shape, renamed). The retired row modes have no
 * surviving equivalent, so they fall back to the default — that choice is gone.
 */
function statusMarkerOf(stored: unknown): StatusMarker {
  if (stored === 'rect' || stored === 'dot') return stored
  return 'rect'
}


interface LocalizedProps {
  t(key: string, params?: Record<string, unknown>): string
}

export interface TaskballHostProps {
  /**
   * The host's selector hooks take an optional equality function as their
   * second argument. Supplying it is REQUIRED for any selector that builds a
   * new value, otherwise the hook sees a changed snapshot on every read and
   * re-renders forever.
   */
  readonly useSessions: <S>(selector: (state: {
    readonly ids: readonly string[]
    readonly byId: Record<string, TaskballSession>
    /**
     * Arrival lifecycle of the session list: `pending` until the first
     * successful pull lands (an empty list then means "nothing arrived"), then
     * monotone `ready` ("empty" really means no sessions). Optional because the
     * host row shape is not something this plugin controls; absent is treated
     * as ready, never as pending (D-033).
     */
    readonly phase?: 'pending' | 'ready'
  }) => S, equal?: (left: S, right: S) => boolean) => S
  readonly useSessionStatus: <S>(selector: (state: ReadonlyMap<string, TaskballStatus>) => S, equal?: (left: S, right: S) => boolean) => S
  /**
   * The workspace snapshot carries the registry-global archive set alongside the
   * workspaces themselves (`archivedSessionIds`), which is the only place the
   * client can read D-005's archive fact from.
   */
  readonly useWorkspaces: <S>(selector: (state: {
    readonly items: readonly TaskballWorkspace[]
    readonly archivedSessionIds?: readonly string[]
  }) => S, equal?: (left: S, right: S) => boolean) => S
}

/**
 * The host's `useSessions` is a `SnapshotSelectorHook`:
 * `<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S`, wired to
 * `useSyncExternalStoreWithSelector`. The selector runs on every store read, so
 * a selector that builds a fresh array is a NEW value every time; without an
 * `eq` the hook compares with `Object.is`, decides the snapshot changed, and
 * re-renders forever. The loop ends when the slot's error boundary unmounts the
 * overlay — the ball simply vanishes, with nothing in the console (bug reported
 * 2026-10-27: switching workspace and sending a message killed the ball).
 *
 * The fix is the equality function, not a cache: the host provides `eq` for
 * exactly this, and the official plugins use it the same way
 * (`dsh-client-ui-workflow-run` passes `shallowEqual`).
 *
 * The `undefined` guards are NOT defensive padding: the host's memoized
 * selector calls `isEqual(currentSelection, nextSelection)` with
 * `currentSelection` still undefined on the first read, so an `eq` that
 * dereferences its arguments throws on mount.
 */
export function sameSessionList(
  left: readonly TaskballSession[] | undefined,
  right: readonly TaskballSession[] | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Same idea for the status map: compare entry by entry, not by identity. */
export function sameStatusMap(
  left: ReadonlyMap<string, TaskballStatus> | undefined,
  right: ReadonlyMap<string, TaskballStatus> | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    if (right.get(id) !== status) return false
  }
  return true
}

/** One workspace snapshot: the real workspaces plus the registry archive set. */
export interface WorkspaceView {
  readonly items: readonly TaskballWorkspace[]
  readonly archivedSessionIds: ReadonlySet<string>
}

/**
 * Compare a workspace snapshot. Both parts matter: the archive set decides
 * whether an archived failure still occupies the ring (D-005), so ignoring it
 * would freeze the ball on a stale archive state.
 */
export function sameWorkspaceView(
  left: WorkspaceView | undefined,
  right: WorkspaceView | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (!sameArchiveSet(left.archivedSessionIds, right.archivedSessionIds)) return false
  const a = left.items
  const b = right.items
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const leftItem = a[index]
    const rightItem = b[index]
    if (leftItem === rightItem) continue
    if (leftItem === undefined || rightItem === undefined) return false
    if (leftItem.workspaceId !== rightItem.workspaceId
      || leftItem.title !== rightItem.title
      || leftItem.path !== rightItem.path) return false
    const leftIds = Array.isArray(leftItem.sessionIds) ? leftItem.sessionIds : []
    const rightIds = Array.isArray(rightItem.sessionIds) ? rightItem.sessionIds : []
    if (leftIds.length !== rightIds.length) return false
    for (let i = 0; i < leftIds.length; i += 1) {
      if (leftIds[i] !== rightIds[i]) return false
    }
  }
  return true
}

function sameArchiveSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

/** Project the host's workspace snapshot into the shape the derivation needs. */
function toWorkspaceView(state: {
  readonly items?: readonly TaskballWorkspace[]
  readonly archivedSessionIds?: readonly string[]
} | undefined): WorkspaceView {
  return {
    items: Array.isArray(state?.items) ? state.items : [],
    archivedSessionIds: new Set(Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []),
  }
}

function toSessions(state: { ids: readonly string[]; byId: Record<string, TaskballSession> }): TaskballSession[] {
  return state.ids
    .map((id) => state.byId[id])
    .filter((session): session is TaskballSession => session !== undefined)
}

/** A stable string for a colour map's CONTENT, usable as a React dependency. */
function colorsKey(colors: ReadonlyMap<string, TaskballColor>): string {
  return Array.from(colors.entries())
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([id, color]) => `${id}:${color}`)
    .join('|')
}

/** A stable string for a folded set's CONTENT, usable as a React dependency. */
function foldedKey(folded: ReadonlySet<string>): string {
  return Array.from(folded).sort().join('|')
}

/**
 * Derivation failures used to be invisible: the render throw was swallowed by
 * the slot's error boundary, the ball vanished, and a reload restored it. Keep
 * the last few on the window so a "the ball disappeared" report can be diagnosed
 * from the console instead of guessed at.
 */
export interface DeriveFailure {
  readonly message: string
  readonly at: number
}

export function noteDeriveFailure(error: unknown): void {
  const failure: DeriveFailure = {
    at: Date.now(),
    message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
  }
  const scope = globalThis as { __taskballDeriveFailures?: DeriveFailure[] }
  const list = scope.__taskballDeriveFailures ?? []
  list.push(failure)
  scope.__taskballDeriveFailures = list.slice(-5)
  console.error(`[taskball] deriveView failed: ${failure.message}`)
}

export function TaskballOverlay(props: LocalizedProps & TaskballHostProps & {
  readonly openSession?: (sessionId: string) => void
  /** The shared settings entry; the writer that owns every write to it. */
  readonly configForm?: SettingsForm | undefined
  /**
   * Opens the plugin's own page in the host's settings dialog. Absent when this
   * host exposes no settings UI at all, so the quick popup hides the entry
   * rather than offering a control that cannot work (F-009).
   */
  readonly openSettings?: (() => boolean) | undefined
}): React.ReactElement {
  const { t } = props
  const [expanded, setExpanded] = React.useState(false)
  // The quick settings popup and the task panel are siblings, not modes of each
  // other: one edits appearance, the other lists sessions (F-009).
  const [quickOpen, setQuickOpen] = React.useState(false)
  const [quickFailed, setQuickFailed] = React.useState(false)
  const [bubble, setBubble] = React.useState<{ id: string; color: TaskballColor } | undefined>(undefined)
  const [anchor, setAnchor] = React.useState<BallPosition | undefined>(undefined)
  // Collapsed form (F-021 / D-063). `collapsed` is the user's INTENT; whether the
  // bar can actually be shown is derived below, because a narrow window must fall
  // back to the ball rather than squeeze the bar into the gutter.
  const [collapsed, setCollapsed] = React.useState(readCollapsed)
  // The position to restore on click. The user's rule is "回到收起前的坐标", not
  // "the line it was attached to", so this stores the exact coordinates.
  //
  // Seeded from storage: a collapse that survives a reload has no in-memory
  // "before" state, and without this the first restore after a refresh would put
  // the ball in a default corner instead of where it actually was.
  const collapsedFrom = React.useRef<BallPosition | undefined>(readPlacement()?.position)
  const [stripPlacement, setStripPlacement] = React.useState<StripBox | undefined>(undefined)
  // Every one of these selectors builds a new value, so every one of them MUST
  // carry an equality function. Without it the host hook compares with
  // `Object.is`, sees a "changed" snapshot on every read and re-renders in a
  // loop until the slot's error boundary unmounts the overlay (bug 2026-10-27).
  const list = props.useSessions((state) => toSessions(state), sameSessionList)
  // D-033: the list's arrival phase is the ONLY reliable "empty vs not yet"
  // signal. A primitive selector needs no equality function of its own:
  // `Object.is` is exactly right for a string union.
  const sessionPhase = props.useSessions((state) => state.phase, Object.is)
  const statuses = props.useSessionStatus((state) => state, sameStatusMap)
  const workspaceView = props.useWorkspaces((state) => toWorkspaceView(state), sameWorkspaceView)
  const workspaces = workspaceView.items
  const hostResult = useHostState()
  const host = hostResult.state
  // Both inputs must have answered once before the ball may claim anything:
  // before that, an empty view means "not loaded", not "nothing to report".
  const loading = sessionPhase === 'pending' || !hostResult.ready
  // F-001: unsent content comes from the host's own conversation store. It is
  // read on its own 5s timer (the same cadence as the Host-state poll), and it
  // is the ONLY input that can admit a `blank` session into the derivation.
  const draftIds = useDraftIds()
  const now = useNow()
  const viewportWidth = globalThis.innerWidth ?? 0
  const viewportHeight = globalThis.innerHeight ?? 0

  /**
   * Sessions this page has personally watched running (B-009 follow-up).
   *
   * `deriveView` cannot answer "is a turn in flight" from the Host record alone:
   * an unfinished turn there is PERMANENT for sessions whose `turn/end` was lost
   * to a plugin restart — measured 2026-10-30, 7 of 48 stored records had sat that
   * way for 1.9–6.7 days, and the first version of the fix painted all of them
   * blue (the "lots of blue but they are all finished" report). This map is the
   * second witness: it only says "still running" for a session the live status
   * has shown as running within the last two poll intervals.
   */
  const watchedRunning = React.useRef<FlightWitnesses>(EMPTY_WITNESSES)
  const runningIds = React.useMemo(() => {
    const ids: string[] = []
    for (const [id, status] of statuses) {
      if (status.running === true) ids.push(id)
    }
    return ids
  }, [statuses])
  watchedRunning.current = noteRunning(watchedRunning.current, runningIds, now)
  // Prune on the coarse tick too, so a page left open does not accumulate an
  // entry per session forever.
  watchedRunning.current = pruneWitnesses(
    watchedRunning.current,
    now,
    flightWindowMs(DEFAULT_POLL_MS),
  )

  // Every settings surface renders from ONE writer (D-046). It applies a change
  // locally the moment a control moves and reconciles with the Host answer,
  // which costs a plugin-entry reload: 1–2.7 s measured 2026-10-29. Reading the
  // form directly here would make the ball wait for that reload before it shows
  // a colour-blind toggle or an opacity change.
  const settingsSession = useSettings(props.configForm)
  const settings = settingsSession.view.values
  const bubbleDurationMs = typeof settings.bubbleDurationMs === 'number' ? settings.bubbleDurationMs : 2000
  // Master switch for every state-change bubble (user 2026-11-03). Named for what
  // it now does, not for its old completion-only job: the same stored field
  // (`bubbleOnCompletion`, kept for compatibility) gates red/yellow/green alike.
  const bubbleEnabled = settings.bubbleOnCompletion !== false
  const showFoldedCount = settings.showFoldedCount !== false
  const showFoldedSection = settings.showFoldedSection !== false
  const closeOnOutsideClick = settings.closeOnOutsideClick !== false
  // F-002 / D-075: the defaults moved to frosted + 30% alpha, so a config that has
  // never been written (a fresh install, or a Host that has not answered yet) must
  // render that same look. A hard-coded 100 here would have shown a solid panel for
  // a frame before the real value arrived.
  const panelOpacity = typeof settings.panelOpacity === 'number' ? settings.panelOpacity : 30
  const panelFrosted = settings.panelFrosted !== false
  const foldAnimation: FoldAnimation = settings.foldAnimation === 'slide-down' ? 'slide-down' : 'slide-out'
  const statusMarker: StatusMarker = statusMarkerOf(settings.statusMarker)
  // D-031: the colour-blind variant only swaps two fills, but every surface that
  // paints a status colour must read the SAME palette object, or the ball and the
  // panel would disagree after a toggle.
  const palette = paletteFor(settings.colorBlindMode === true)
  // `host` leaves the CSS variable in charge, so the panel tracks the app's own
  // content size (including its zoom shortcuts) instead of freezing a number.
  const fontSizePx = settings.fontSizeMode === 'custom' && typeof settings.fontSizePx === 'number'
    ? settings.fontSizePx
    : undefined
  const statusMarkerValue = String(settings.statusMarker ?? 'bar')
  // F-018: one resolved diameter for every surface that anchors against the ball.
  // `ballSizePx` degrades to the medium preset for any unknown value, so a stale or
  // hand-edited config cannot make the ball render at `NaN` px (an invisible ball
  // with no console error).
  const ballSize = ballSizePx(typeof settings.ballSize === 'string' ? settings.ballSize : undefined)
  // F-019: 0 is meaningful (snapping off), so this must not fall back on `?? 16`
  // for a legitimate 0 — only for `undefined`.
  const snapDistance = typeof settings.snapDistance === 'number' ? settings.snapDistance : SNAP_DISTANCE
  const quickValues: QuickValues = {
    panelFrosted: settings.panelFrosted === true,
    panelOpacity,
    // Same field the settings page writes, and the same value the bubble logic
    // already reads — the popup only surfaces it.
    bubbleOnCompletion: bubbleEnabled,
    // F-020 (user 2026-11-01): the two additions are the SAME fields the
    // settings page writes — `FIELDS` stays the single owner of what a setting is.
    showFoldedSection: settings.showFoldedSection !== false,
    fontSizeMode: String(settings.fontSizeMode ?? 'host'),
    fontSizePx: typeof settings.fontSizePx === 'number' ? settings.fontSizePx : 13,
    // D-073 (user 2026-11-02): ball size moved INTO the popup, replacing status
    // marker and colour-blind mode. Same preset the settings page writes.
    ballSize: String(settings.ballSize ?? 'medium'),
  }

  // A throw anywhere in here unmounts the ENTIRE overlay through the slot's
  // error boundary, and the only visible symptom is "the ball disappeared"
  // (a reload brings it back, which is what made this so hard to pin down —
  // measured twice, 2026-10-27/28). Rather than let one malformed row or one
  // unexpected host shape kill the plugin, derivation failures degrade to the
  // last good view and record themselves so the failure is inspectable.
  const lastGood = React.useRef<ReturnType<typeof deriveView> | undefined>(undefined)
  let view: ReturnType<typeof deriveView>
  try {
    view = deriveView(
      list,
      statuses,
      workspaces,
      host,
      now,
      { archivedSessionIds: workspaceView.archivedSessionIds },
      watchedRunning.current,
      flightWindowMs(DEFAULT_POLL_MS),
      draftIds,
    )
    lastGood.current = view
  } catch (error) {
    noteDeriveFailure(error)
    view = lastGood.current ?? { entries: [], failures: new Map(), folded: new Set(), drafts: [] }
  }
  const entries = taskEntries(view.entries)
  const colors = new Map<string, TaskballColor>(entries.map((entry) => [entry.id, entry.color]))
  const previous = React.useRef<Map<string, TaskballColor> | undefined>(undefined)
  const [spin, setSpin] = React.useState<'left' | 'right' | undefined>(undefined)

  /**
   * Track the composer card so the collapsed bar can sit against it.
   *
   * The card's position is not fixed — measured 2026-10-31: y=778 with messages,
   * y=447 in a blank conversation's hero layout — and it also moves when the
   * sidebar collapses, the right pane opens or the window resizes. The same
   * MutationObserver signal the ball's snapping uses is reused here rather than
   * adding a second layout listener, so there is exactly one owner of "layout
   * changed".
   */
  const syncStrip = React.useCallback((): void => {
    const doc = globalThis.document
    const card = readComposerCard(doc)
    const box = stripBox(
      card,
      readCenterColumn(doc),
      STRIP_WIDTH,
      STRIP_HEIGHT,
      STRIP_GAP,
      globalThis.innerHeight ?? 0,
      // The gutter budget is "bar + gap + a whole ball", so a larger ball needs a
      // wider gutter before collapsing is allowed (F-018). Reading the live size
      // keeps that rule true instead of silently rejecting the wrong widths.
      ballSize,
    )
    setStripPlacement((current) => {
      if (current === undefined && box === undefined) return current
      if (current !== undefined && box !== undefined
        && current.left === box.left && current.top === box.top) return current
      return box
    })
    // `ballSize` is in the deps: the gutter budget depends on it, so changing the
    // size must re-evaluate whether the bar still fits (F-018).
  }, [ballSize])

  React.useEffect(() => {
    syncStrip()
    const onResize = (): void => { syncStrip() }
    globalThis.addEventListener?.('resize', onResize)
    const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
    const root = globalThis.document?.body ?? globalThis.document?.documentElement
    const observer = Observer === undefined || root === null || root === undefined
      ? undefined
      : new Observer((records) => {
        // Our own surfaces write styles constantly (drag, animations); reacting to
        // those would make the bar chase its own tail.
        if (records.every((record) => isOwnSurface(record.target))) return
        syncStrip()
      })
    observer?.observe(root as Node, { attributeFilter: ['style', 'class'], attributes: true, subtree: true })
    // The composer appears after the first session pull; a poll keeps the bar
    // honest through the frames the observer cannot see (e.g. a re-render that
    // changes the card's height without touching any observed attribute).
    const timer = setInterval(() => { syncStrip() }, 1000)
    return () => {
      globalThis.removeEventListener?.('resize', onResize)
      observer?.disconnect()
      clearInterval(timer)
    }
  }, [syncStrip])

  /**
   * Collapse is advertised only while it can actually be honoured.
   *
   * Two independent gates: the bar needs a wide enough gutter (`stripBox` returns
   * undefined otherwise), and a touch device gets no collapse at all — the bar is a
   * hover-only affordance with no room for a 44px touch target, so offering it there
   * would just be a control people cannot hit (user 2026-10-31: 触屏设备不支持该功能).
   * `matchMedia` is read per render rather than cached: a tablet switching between
   * a keyboard and a finger changes the answer without a reload.
   */
  const coarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches === true
  const canCollapse = stripPlacement !== undefined && !coarsePointer
  const collapsedActive = collapsed && canCollapse
  // The bar stays put until it is CLICKED. Hover must not move the ball: the user's
  // rule is "click to restore" (批注 4), and a hover swap would teleport the ball
  // whenever the pointer merely crossed the bar on its way somewhere else.
  const showStrip = collapsedActive

  React.useEffect(() => {
    const before = previous.current
    previous.current = new Map(colors)
    if (before === undefined) return
    const [transition] = transitionsOf(before, colors, bubbleEnabled)
    if (transition === undefined) return
    setBubble({ id: transition.id, color: transition.to })
    // `colors` is rebuilt on every render, so depending on it would re-run this
    // effect constantly. The colour map's CONTENT is what matters, and it
    // changes only when a session's state actually changes.
  }, [colorsKey(colors), bubbleEnabled])

  React.useEffect(() => {
    if (bubble === undefined) return
    const timer = setTimeout(() => { setBubble(undefined) }, bubbleDurationMs)
    return () => { clearTimeout(timer) }
  }, [bubble, bubbleDurationMs])

  // Clear the spin flag once the transition has run, so the next open can start
  // a fresh turn from zero instead of staying stuck at 360deg.
  React.useEffect(() => {
    if (spin === undefined) return
    const timer = setTimeout(() => { setSpin(undefined) }, 460)
    return () => { clearTimeout(timer) }
  }, [spin])

  const writer = React.useMemo(() => createHostWriter(), [])

  /**
   * Folds the user just requested, applied to BOTH surfaces before the Host
   * confirms (D-034).
   *
   * The Host remains the durable owner, but its confirmation rides the next 5s
   * poll. Making the panel's semantics wait for that is exactly what forced the
   * old `awaitingFold` suppression: the row's visibility depended on poll
   * timing. Here the semantic state changes on click, the exit animation is
   * decoration, and `pruneFoldOverrides` hands control back once the Host
   * agrees (or a failed write expires).
   */
  const [foldOverrides, setFoldOverrides] = React.useState<ReadonlyMap<string, FoldOverride>>(() => new Map())
  const overrideTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())
  React.useEffect(() => () => {
    for (const timer of overrideTimers.current.values()) clearTimeout(timer)
    overrideTimers.current.clear()
  }, [])

  const hostFolded = view.folded
  const effectiveFolded = overriddenFolds(hostFolded, foldOverrides)
  // Identity is preserved when no override applies, so the panel's own memo and
  // the ball keep reading the exact Host set in the common case.
  const effectiveView = effectiveFolded === hostFolded ? view : { ...view, folded: effectiveFolded }

  React.useEffect(() => {
    const pruned = pruneFoldOverrides(foldOverrides, hostFolded, colors, Date.now(), FOLD_RECONCILE_MS)
    if (pruned === foldOverrides) return
    for (const id of foldOverrides.keys()) {
      if (pruned.has(id)) continue
      const timer = overrideTimers.current.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        overrideTimers.current.delete(id)
      }
    }
    setFoldOverrides(pruned)
  }, [foldOverrides, colorsKey(colors), foldedKey(hostFolded)])

  const requestFold = (id: string, color: TaskballColor, folded: boolean): void => {
    setFoldOverrides((current) => new Map(current).set(id, { folded, color, at: Date.now() }))
    const existing = overrideTimers.current.get(id)
    if (existing !== undefined) clearTimeout(existing)
    // Safety net for a FAILED write, not a timing budget for a successful one:
    // when the Host never agrees, the row must come back instead of staying
    // hidden forever.
    const timer = setTimeout(() => {
      overrideTimers.current.delete(id)
      setFoldOverrides((current) => {
        if (!current.has(id)) return current
        const next = new Map(current)
        next.delete(id)
        return next
      })
    }, FOLD_RECONCILE_MS)
    overrideTimers.current.set(id, timer)
    void writer.fold(id, color, folded)
  }

  /**
   * The ball spins toward the side the panel opens on, so the motion reads as
   * the ball presenting the panel. Closing spins the OPPOSITE way: re-using the
   * opening direction made the collapse look like a second opening.
   *
   * Every close path goes through here — the ball toggle, the panel's × button
   * and opening a session — otherwise those two closures dropped the animation
   * and the ball sat still while the panel vanished.
   */
  const closePanel = (): void => {
    setSpin((current) => {
      if (current !== undefined) return current === 'left' ? 'right' : 'left'
      const opensLeft = anchor === undefined ? false : anchor.x + 312 + 10 > viewportWidth
      return opensLeft ? 'right' : 'left'
    })
    setExpanded(false)
  }

  const toggleExpanded = (): void => {
    if (expanded) {
      closePanel()
      return
    }
    const opensLeft = anchor === undefined ? false : anchor.x + 312 + 10 > viewportWidth
    setSpin(opensLeft ? 'left' : 'right')
    setExpanded(true)
  }

  const closePanelRef = React.useRef(closePanel)
  React.useEffect(() => { closePanelRef.current = closePanel })

  /**
   * One outside-click listener owns BOTH overlay layers (F-003 + F-009).
   *
   * A second listener for the quick popup would be a second owner for the same
   * fact — exactly the shape AGENTS.md §2.11 forbids: two listeners that each
   * decide "is this click outside me" drift the moment an element is added to
   * one of them. Here the selector list carries every surface that counts as
   * "inside", and each layer closes only if it is the one open.
   *
   * The listener is capture-phase but PASSIVE and never stops propagation:
   * `shell.overlay` is click-through, so the very click that closes a layer
   * must still reach the host UI underneath (sidebar, conversation, top bar).
   * Panel closes go through `closePanel`, because the ball's closing spin is
   * part of every other close path (D-029).
   *
   * A pointer on the ball, the panel, the bubble or the quick popup is not
   * "outside": the ball's own pointerdown toggles the panel, and each surface's
   * controls must keep working. `closest` is duck-typed so a non-Element target
   * (or an element from another realm) simply counts as outside.
   */
  React.useEffect(() => {
    if (!expanded && !quickOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      // Primary button only: a right-click context menu elsewhere should not
      // dismiss these layers.
      if (event.button !== 0) return
      const target = event.target as { closest?: (selector: string) => Element | null } | null
      if (typeof target?.closest === 'function'
        && target.closest(INSIDE_SELECTOR) !== null) return
      if (quickOpen) setQuickOpen(false)
      if (expanded && closeOnOutsideClick) closePanelRef.current()
    }
    globalThis.document?.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    return () => globalThis.document?.removeEventListener('pointerdown', onPointerDown, true)
  }, [expanded, quickOpen, closeOnOutsideClick])

  /**
   * One field write from the quick popup. The shared writer owns the write
   * itself — optimistic overlay, burst coalescing, no stale revision (D-046) —
   * so the popup shows the new value at once instead of waiting for the Host's
   * plugin-entry reload (1–2.7 s measured 2026-10-29).
   */
  const writeQuickSetting = (field: string, value: unknown): void => {
    settingsSession.writer.set(field, value)
  }

  const toggleQuick = (): void => {
    setQuickFailed(false)
    setQuickOpen((current) => {
      if (current) return false
      // The popup takes the ball's attention, so the panel steps aside: two
      // overlays anchored to one ball would overlap on every screen.
      setExpanded(false)
      return true
    })
  }

  const bubbleTitle = bubble === undefined
    ? ''
    : entries.find((entry) => entry.id === bubble.id)?.title ?? ''

  return h('div', null,
    h(TaskballPanel, {
      anchor,
      ballSize,
      expanded,
      fontSizePx,
      // The panel reads the SAME derivation the ball does — now including the
      // local fold overrides — so the two surfaces cannot disagree about colour,
      // fold state, expiry or archive status (D-028 / D-034).
      view: effectiveView,
      onBulkFold: (ids, folded) => {
        for (const id of ids) {
          const color = colors.get(id)
          if (color !== undefined) requestFold(id, color, folded)
        }
      },
      onClose: () => { closePanel() },
      onOpenSession: (id) => {
        props.openSession?.(id)
        closePanel()
      },
      onToggleFolded: (id, color, folded) => {
        requestFold(id, color, folded)
      },
      foldAnimation,
      loading,
      onOpenQuick: toggleQuick,
      palette,
      panelFrosted,
      panelOpacity,
      showFoldedCount,
      showFoldedSection,
      statusMarker,
      t,
      viewportHeight,
      viewportWidth,
      workspaces,
    }),
    // The collapsed bar REPLACES the ball (user 2026-10-31: the sketch's ball is
    // the expanded form), so exactly one of the two is mounted. It stays a bar until
    // CLICKED: hover only raises its affordance (see TaskballStrip's own styles), it
    // never moves the ball (批注 4).
    showStrip && stripPlacement !== undefined
      ? h(TaskballStrip, {
        entries,
        // `effectiveFolded`, NOT `view.folded`: the local override is what makes a
        // tick take effect on click (D-034). Passing the Host set here would leave
        // the segment on the bar for up to a poll interval after the user handled
        // it, while the panel had already moved the row.
        folded: effectiveFolded,
        left: stripPlacement.left,
        onQuick: toggleQuick,
        onRestore: () => {
          setCollapsed(false)
          writeCollapsed(false)
        },
        palette,
        t,
        top: stripPlacement.top,
      })
      : h(TaskballBall, {
        entries,
        ballSize,
        snapDistance,
        expanded,
        folded: effectiveFolded,
        // Restoring lands exactly where the ball was when it collapsed, not on a
        // snap line it happened to be attached to (user 2026-10-31: 回到收起前的坐标).
        initialPosition: collapsedFrom.current,
        loading,
        onPositionChange: setAnchor,
        onQuick: toggleQuick,
        onToggle: toggleExpanded,
        palette,
        spin,
        t,
      }),
    quickOpen
      ? h(TaskballQuick, {
        anchor,
        ballSize,
        // The popup is reachable only while the page it lives in can host it;
        // `undefined` hides the "open all settings" row instead of dead-ending.
        onClose: () => { setQuickOpen(false) },
        onOpenAllSettings: props.openSettings === undefined
          ? undefined
          : () => {
            // Opening the panel means leaving this popup: it would otherwise sit
            // on top of the page it just opened. A failed route keeps the popup
            // open and shows why (the failure is also on the window).
            const opened = props.openSettings?.() === true
            if (opened) setQuickOpen(false)
            else setQuickFailed(true)
          },
        onSet: writeQuickSetting,
        // Two different failures land in one alert here: a refused write
        // (`view.failed`, honest per-field reporting lives in the writer) and a
        // route that could not open the full page. The popup stays open either
        // way; the route failure is also recorded on `window` by open-settings.
        saveFailed: quickFailed || settingsSession.view.failed,
        t,
        values: quickValues,
        viewportHeight,
        viewportWidth,
        // Collapse is offered only while it can be honoured; the popup hides the
        // row otherwise (see `canCollapse`). Reading the CURRENT anchor here is
        // what makes "回到收起前的坐标" possible: the ball's settled position is
        // the thing to restore, not the snap line it happened to be attached to.
        onCollapse: canCollapse
          ? () => {
            collapsedFrom.current = anchor
            setCollapsed(true)
            writeCollapsed(true)
            setQuickOpen(false)
          }
          : undefined,
      })
      : null,
    // The bubble anchors to `anchor`, the ball's LAST settled position. While the
    // bar is shown there is no ball at that position — the bar REPLACED it (F-021)
    // — so a bubble would appear at an empty spot on screen (user 2026-11-03:
    // Desktop showed completion bubbles floating where the ball used to be).
    // Suppress it outright rather than re-anchor to the bar: the bar is a thin
    // strip against the composer, and a bubble there would cover the input.
    // Nothing is lost by staying silent — the bar itself already paints the
    // per-task status colours, which is the whole point of the collapsed form.
    bubble === undefined || showStrip
      ? null
      : h(TaskballBubble, {
        anchor,
        ballSize,
        palette,
        title: bubbleTitle,
        transition: { from: 'blue', id: bubble.id, to: bubble.color },
        t,
        viewportHeight,
        viewportWidth,
      }))
}

export const name = 'dsh-useful-taskball'
// The Client half needs no `connection` service at all: Host state is read with
// a plain same-origin `fetch` to our own exact `/api` routes (see host-state.ts
// for why the RPC entries are unusable). Keeping it out of `inject` also keeps
// the entry active when that service is absent.
//
// `shortcuts` is optional for the same reason and is therefore NOT listed here:
// it is read through `ctx.get('shortcuts')` for the one thing it enables
// (opening the host settings dialog from the quick popup). A host without it
// loses that button, not the ball.
export const inject = ['slots', 'locale', 'uiWorkspace', 'configForms']

// Exposed for tests: the panel and the ball are not reachable through the
// closed-by-default overlay, so their markup can only be verified directly.
export const __test__ = {
  MAX_ANIMATED_BOUNDARIES,
  animatedBallGradient,
  canAnimateSlices,
  registerBoundaryProperties,
  sectorVariables,
  seamAngleOf,
  seamVar,
  DRAFT_KEY_PREFIX,
  DRAFT_POLL_MS,
  hasDraftContent,
  readDraftIds,
  NO_DRAFT_IDS,
  COLOR_BLIND_PALETTE,
  COLOR_HEX,
  COLOR_HEX_CB,
  COLOR_INK,
  COLOR_INK_CB,
  DEFAULT_PALETTE,
  HOST_READY_GRACE_MS,
  SNAP_DISTANCE,
  // Drag-vs-click slop (reported 2026-11-01): the test asserts the exact value
  // and the behaviour it produces, so it must be reachable from `__test__`.
  DRAG_THRESHOLD_PX,
  // F-021 collapsed bar (D-063): the geometry helpers and the seam rule are pure
  // functions, and the component is unreachable through the closed overlay, so all
  // of it is exposed here for direct verification.
  MIN_SEAM_SEGMENT_PX,
  SEAM_PX,
  STRIP_GAP,
  STRIP_HEIGHT,
  STRIP_WIDTH,
  TaskballBall,
  TaskballBubble,
  TaskballPanel,
  TaskballQuick,
  TaskballStrip,
  readComposerCard,
  seamsVisible,
  segmentHeight,
  stripBox,
  stripGutterBudget,
  stripSegments,
  orderEntries,
  COLLAPSED_KEY,
  readCollapsed,
  writeCollapsed,
  sectorAngles,
  // Exposed so the strip test can assert "bar and ring draw the same sessions"
  // against the SHARED predicate instead of re-implementing the rule in the test.
  sectorEntries,
  WRITE_DELAY_MS,
  bubbleSide,
  bubbleTop,
  clampPosition,
  createSettingsWriter,
  exitDurationMs,
  followAttachment,
  needsRedConfirm,
  openPluginSettings,
  paletteFor,
  panelPlacement,
  pluginManagerNavigation,
  quickPlacement,
  // F-015 (user 2026-11-01): the tail size and the outline weight are the two
  // numbers the bubble polish actually changed, so both must be assertable.
  TAIL,
  BUBBLE_OUTLINE_PX,
  readCenterColumn,
  readPlacement,
  snapPosition,
  snapTargets,
  writePlacement,
  sameSessionList,
  sameStatusMap,
  sameWorkspaceView,
  settingsWriterFor,
  tintOf,
  toSessions,
  toWorkspaceView,
  transitionsOf,
}

export function apply(ctx: TaskballClientContext): void {
  // Style injection is unconditional and first (AGENTS.md §9): if it ran after
  // any service guard, a reload that raced the service would leave the panel
  // and the bubble unstyled.
  ctx.effect(injectStyle, 'taskball: style')
  // F-010 (D-055): the ring animates by transitioning registered custom
  // properties, and a property that was never registered cannot be
  // transitioned at all — the sector change would simply cut. Registering is
  // idempotent (a second activation throws and is swallowed), so it belongs
  // here beside the style sheet, before anything can paint a ball.
  registerBoundaryProperties()
  // `plugins.bundle.config` receives no `form` owner prop: the page only renders
  // `{ view }`. A bundle reads and writes its own entry through `configForms`,
  // keyed by the Host entry id this patch inserts.
  //
  // The form is a SHARED singleton owned by the `configForms` provider, which
  // disposes every form it created on its own teardown. Disposing it here would
  // outlive this fiber: the provider's Map keeps the dead instance, the next
  // fiber's `get()` hands it back, and its `derive()` subscription is already
  // gone — so `revision` freezes at whatever it was, every write is refused as
  // a stale conflict, and the page reports "Save failed" forever (B-003).
  const configForm = ctx.configForms.get('dsh-useful-taskball')
  ctx.effect(() => ctx.locale.register('taskball', { en, zh }), 'taskball: locale')
  // `layout` and the manager's store are both OPTIONAL, so neither is in
  // `inject` (AGENTS.md §6.7 / §13): `ctx.get` returns undefined instead of
  // throwing, and `openPluginSettings` reports false so the popup hides the entry
  // rather than dead-ending on a control that cannot work.
  //
  // The service must be handed over as an OBJECT, not a detached method: the
  // host's implementation reads `this` (`measured 2026-10-29`, see
  // open-settings.ts).
  const openSettings = (): boolean => openPluginSettings({
    layout: ctx.get('layout') as LayoutLike,
    slots: ctx.slots as SlotsLike,
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'dsh-useful-taskball', order: 100, locale: 'taskball' },
    (props: LocalizedProps & TaskballHostProps) => h(TaskballOverlay, {
      ...props,
      configForm,
      openSession: (id: string) => { ctx.uiWorkspace.openSession(id) },
      openSettings,
    }),
  ))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: 'dsh-useful-taskball', locale: 'taskball' },
    (props: LocalizedProps & { view: 'summary' | 'page' }) => h(TaskballSettings, {
      form: configForm,
      t: props.t,
      view: props.view,
    }),
  ))
}

export { classifyStatus }
export type { TaskballPanelProps }
