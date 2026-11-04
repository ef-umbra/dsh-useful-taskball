import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveView } from '../lib/model.mjs'

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const window = {
    __ModuleLoader__: {
      load(definition) {
        client = definition.factory((specifier) => {
          if (specifier === 'react') return React
          throw new Error(`Unexpected require: ${specifier}`)
        })
      },
    },
  }
  // The real client runs in a browser, so the bundle may use timers and
  // localStorage. The settings writer coalesces writes with `setTimeout`, and
  // the ball keeps its placement in storage — a missing global here would be a
  // harness gap, not a product bug. Each load gets a FRESH storage map, so tests
  // cannot leak a stored ball position into each other.
  const storage = new Map()
  const globals = {
    window,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    },
  }
  vm.runInNewContext(source, globals)
  Object.defineProperty(client, '__storage', { value: storage })
  return client
}

function makeConfigForm(overrides = {}) {
  const disposeCalls = []
  let snapshot = {
    status: 'ready',
    value: {
      completionRetentionMinutes: 30,
      bubbleDurationMs: 2000,
      bubbleOnCompletion: false,
      showFoldedCount: true,
      panelOpacity: 100,
    },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    ...overrides,
  }
  const listeners = new Set()
  return {
    disposeCalls,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async () => true,
    set: async () => true,
    unset: async () => true,
    dispose: () => { disposeCalls.push('form') },
    __push(next) { snapshot = { ...snapshot, ...next }; for (const l of listeners) l() },
  }
}

function makeConnection(state = { retentionMs: 30 * 60_000, sessions: {} }) {
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'state') return { ok: true, value: state }
        if (endpoint === 'fold') return { ok: true, value: { foldedAt: 1 } }
        return { ok: false, error: { code: 'not-found', message: endpoint } }
      },
    },
  }
}

async function registrationsOf(formOverrides = undefined, connection = makeConnection()) {
  const client = await loadClient()
  const registrations = []
  const opened = []
  const effectDisposers = []
  const configForm = makeConfigForm(formOverrides)
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    uiWorkspace: { openSession: (id) => { opened.push(id) } },
    configForms: { get: () => configForm },
    // Real `ctx.effect` runs the callback now and its returned disposer on fiber
    // teardown. Stubbing that away hides every "cleanup destroys a shared
    // singleton" bug (B-003), so this records and can actually tear down.
    effect: (callback) => {
      const dispose = callback()
      const teardown = () => { if (typeof dispose === 'function') dispose() }
      effectDisposers.push(teardown)
      return teardown
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (_key, callback) => { callback(); return () => {} },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  client.apply(ctx)
  return { client, registrations, opened, configForm, connection, effectDisposers }
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

const sessionsState = {
  ids: ['s1', 's2', 's3', 'sub', 'blank'],
  phase: 'ready',
  byId: {
    s1: { id: 's1', title: '修复登录', displayTitle: '修复登录', blank: false, updatedAt: 1 },
    s2: { id: 's2', title: '写文档', displayTitle: '写文档', blank: false, updatedAt: 2 },
    s3: { id: 's3', title: '', displayTitle: '工作区草稿', blank: false, updatedAt: 3 },
    sub: { id: 'sub', title: '子代理', displayTitle: '子代理', blank: false, origin: 'subagent', updatedAt: 4 },
    blank: { id: 'blank', title: '', displayTitle: '', blank: true, updatedAt: 5 },
  },
}
const statusMap = new Map([
  ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s2', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ['s3', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
])
const workspaceState = {
  items: [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['s1', 's2', 's3'] }],
}
const emptyHost = { retentionMs: 30 * 60_000, sessions: {} }

/** 面板现在接收 overlay 已算好的 view，测试沿用同一推导入口。 */
function panelView(sessions, host, statuses = new Map(), workspaces = workspaceState.items, archived = [], now = 1000) {
  return deriveView(sessions, statuses, workspaces, host, now, { archivedSessionIds: new Set(archived) })
}

const hostProps = {
  t,
  useSessions: (selector) => selector(sessionsState),
  useSessionStatus: (selector) => selector(statusMap),
  useWorkspaces: (selector) => selector(workspaceState),
}

test('悬浮球默认渲染为扇形，面板默认收起', async () => {
  const { registrations } = await registrationsOf()
  const overlay = registrations.find(({ options }) => options.name === 'shell.overlay')
  const markup = renderToStaticMarkup(React.createElement(overlay.component, hostProps))
  assert.ok(markup.includes('data-taskball-ball'))
  assert.equal(markup.includes('data-taskball-panel'), false, '面板应默认收起')
})

// 用户实测 bug（2026-10-27）：切换工作区后发消息，悬浮球整个消失，要重启才回来。
// 根因不是「选择器返回了新数组」本身，而是**没有给等值比较函数**：宿主的
// `useSessions` 是 `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)`，
// `eq` 缺省时用 `Object.is`，所以每次读都被判定为「快照变了」→ 无限重渲染 →
// 被 slot 的错误边界卸载（无红字，只表现为球不见）。
// 第一次修法（自己用 WeakMap 缓存投影）没命中真因；正解是传 `eq`。
test('三个选择器都必须带等值比较函数（否则切换工作区会卸载整个 overlay）', async () => {
  const { client } = await registrationsOf()
  const { sameSessionList, sameStatusMap, sameWorkspaceView } = client.__test__
  assert.equal(typeof sameSessionList, 'function')
  assert.equal(typeof sameStatusMap, 'function')
  assert.equal(typeof sameWorkspaceView, 'function')

  const s1 = { id: 's1' }
  const s2 = { id: 's2' }
  // 相同内容的两个数组：eq 必须判为相等（否则每次读都是「变化」）
  assert.equal(sameSessionList([s1, s2], [s1, s2]), true)
  assert.equal(sameSessionList([s1, s2], [s1, s2].slice()), true)
  assert.equal(sameSessionList([s1, s2], [s1]), false)
  assert.equal(sameSessionList([s1], [s2]), false)

  const status = { running: true, pendingInteraction: undefined, completionUnread: false }
  assert.equal(sameStatusMap(new Map([['s1', status]]), new Map([['s1', status]])), true)
  assert.equal(sameStatusMap(new Map([['s1', status]]), new Map()), false)

  const workspace = { workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['s1'] }
  const view = (items, archived) => ({ items, archivedSessionIds: new Set(archived) })
  assert.equal(sameWorkspaceView(view([workspace], []), view([{ ...workspace }], [])), true)
  assert.equal(sameWorkspaceView(view([workspace], []), view([{ ...workspace, sessionIds: ['s2'] }], [])), false)
  // 归档集合是 D-005 的判据，必须参与比较，否则归档后球不会清退红扇区
  assert.equal(sameWorkspaceView(view([workspace], []), view([workspace], ['s1'])), false, '归档集合变化必须触发重算')
})

// 宿主的 memoizedSelector 在第一次读时就会调用 `isEqual(currentSelection, …)`，
// 而此时 currentSelection 还是 undefined。eq 若直接解引用参数就会在挂载时抛错。
test('等值比较函数必须容忍 undefined（宿主首次读取就会传入）', async () => {
  const { client } = await registrationsOf()
  const { sameSessionList, sameStatusMap, sameWorkspaceView } = client.__test__

  assert.equal(sameSessionList(undefined, [1]), false)
  assert.equal(sameSessionList([1], undefined), false)
  assert.equal(sameSessionList(undefined, undefined), true)

  assert.equal(sameStatusMap(undefined, new Map()), false)
  assert.equal(sameStatusMap(new Map(), undefined), false)
  assert.equal(sameStatusMap(undefined, undefined), true)

  const view = (items, archived) => ({ items, archivedSessionIds: new Set(archived) })
  assert.equal(sameWorkspaceView(undefined, view([], [])), false)
  assert.equal(sameWorkspaceView(view([], []), undefined), false)
  assert.equal(sameWorkspaceView(undefined, undefined), true)
})

test('overlay 的三个选择器调用都必须传 eq', async () => {
  const { registrations } = await registrationsOf()
  const overlay = registrations.find(({ options }) => options.name === 'shell.overlay')
  const seen = []
  const spy = (name, state) => (selector, equal) => {
    seen.push({ name, hasEqual: typeof equal === 'function' })
    return selector(state)
  }
  const props = {
    t,
    useSessions: spy('useSessions', { ids: ['s1'], phase: 'ready', byId: { s1: { id: 's1', title: 'a', displayTitle: 'a', blank: false, updatedAt: 1 } } }),
    useSessionStatus: spy('useSessionStatus', new Map()),
    useWorkspaces: spy('useWorkspaces', { items: [] }),
  }
  renderToStaticMarkup(React.createElement(overlay.component, props))
  assert.equal(seen.length, 4, '四个选择器调用（列表 / 到达阶段 / 状态 / 工作区）都应被调用')
  for (const call of seen) {
    assert.equal(call.hasEqual, true, `${call.name} 必须传等值比较函数`)
  }
})

// D-033 (measured 2026-10-28): the ball painted "暂无任务状态" for the 3.7–6.0s
// between the first paint and the first session-list snapshot. Before the first
// successful pull, an empty list means "nothing has arrived", not "nothing
// exists" — the wording must not claim emptiness.
test('D-033：未就绪时球显示加载态，不得宣称「暂无任务状态」', async () => {
  const { client } = await registrationsOf()
  const Ball = client.__test__.TaskballBall
  const base = { entries: [], folded: new Set(), expanded: false, onToggle: () => {}, t }
  const loading = renderToStaticMarkup(React.createElement(Ball, { ...base, loading: true }))
  assert.ok(loading.includes('ball.loading'), '未就绪时必须用加载文案')
  assert.ok(loading.includes('data-loading="true"'), '未就绪时球需要可识别的加载标记（CSS 脉冲）')
  assert.equal(loading.includes('ball.empty'), false)

  const ready = renderToStaticMarkup(React.createElement(Ball, base))
  assert.ok(ready.includes('ball.empty'))
  assert.equal(ready.includes('data-loading'), false)
})

test('D-033：Host 首次读取失败必须有超时兜底，不能永远显示加载中', async () => {
  const { client } = await registrationsOf()
  assert.ok(
    client.__test__.HOST_READY_GRACE_MS >= 10_000,
    '兜底时长必须覆盖至少两个 5s 轮询周期，否则会早于正常首包结束加载态',
  )
})

test('面板渲染分组、标题、勾选框与折叠区', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  assert.equal(typeof panel, 'function')

  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView(
      [sessionsState.byId.s1, sessionsState.byId.s2, sessionsState.byId.s3],
      { retentionMs: 30 * 60_000, sessions: { s2: { foldedAt: 10, foldedColor: 'green' } } },
      statusMap,
    ),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: workspaceState.items,
  }))

  assert.ok(markup.includes('data-taskball-panel'))
  assert.ok(markup.includes('项目一'), '应渲染工作区分组标题')
  assert.ok(markup.includes('修复登录'), '应渲染会话标题')
  assert.ok(markup.includes('工作区草稿'), '标题为空时应回退到 displayTitle')
  assert.ok(markup.includes('type="checkbox"'), '应渲染已处理勾选框')
  assert.ok(markup.includes('panel.folded'), '应渲染折叠区')

  const foldedSectionStart = markup.indexOf('panel.folded')
  const mainArea = markup.slice(0, foldedSectionStart)
  const foldedArea = markup.slice(foldedSectionStart)
  assert.equal(mainArea.includes('写文档'), false, '已折叠条目不应出现在主区')
  assert.ok(foldedArea.includes('写文档'), '已折叠条目应出现在折叠区')
})

test('折叠颜色与当前颜色不符时自动回到主区（D-006）', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    // 折叠时是绿色，但该会话现在正在跑（蓝色）→ 勾选失效
    view: panelView(
      [sessionsState.byId.s1],
      { retentionMs: 30 * 60_000, sessions: { s1: { foldedAt: 10, foldedColor: 'green' } } },
      statusMap,
    ),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: [],
  }))
  assert.ok(markup.includes('修复登录'))
  assert.equal(markup.includes('panel.folded'), false)
})

test('子代理与空白会话不出现在面板中', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView([sessionsState.byId.sub, sessionsState.byId.blank], emptyHost),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: [],
  }))
  assert.equal(markup.includes('子代理'), false)
  assert.ok(markup.includes('panel.empty'))
})

test('灰色（无任务状态）会话不进入面板', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView(
      [
        { id: 'active', title: '正在跑', displayTitle: '正在跑', blank: false, updatedAt: 1 },
        { id: 'idle1', title: '空闲一', displayTitle: '空闲一', blank: false, updatedAt: 2 },
        { id: 'idle2', title: '空闲二', displayTitle: '空闲二', blank: false, updatedAt: 3 },
      ],
      emptyHost,
      new Map([
        ['active', { running: true, pendingInteraction: undefined, completionUnread: false }],
        ['idle1', { running: false, pendingInteraction: undefined, completionUnread: false }],
        ['idle2', { running: false, pendingInteraction: undefined, completionUnread: false }],
      ]),
    ),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: [],
  }))
  assert.ok(markup.includes('正在跑'))
  assert.equal(markup.includes('空闲一'), false)
  assert.equal(markup.includes('空闲二'), false)
  assert.equal(markup.includes('panel.empty'), false)
})

test('红色条目首次勾选弹确认框，不直接折叠（D-006）', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const toggles = []
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView(
      [{ id: 'bad', title: '失败的会话', displayTitle: '失败的会话', blank: false, updatedAt: 1 }],
      { retentionMs: 30 * 60_000, sessions: { bad: { lastTurnEnd: { kind: 'error', message: '连接超时', at: 5 } } } },
      new Map([['bad', { running: false, pendingInteraction: undefined, completionUnread: true }]]),
      [],
    ),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: (id, color, folded) => { toggles.push({ id, color, folded }) },
    t,
    workspaces: [],
  }))
  // 服务端渲染不触发事件，这里只断言初始态没有折叠、且红条目的失败原因可见。
  assert.ok(markup.includes('失败的会话'))
  assert.equal(toggles.length, 0)
  assert.equal(markup.includes('data-taskball-confirm'), false, '确认框只在点击后出现')
})

test('绿色超期条目从面板消失，红色即使很旧也保留', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const now = 100 * 60_000
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView(
      [
        { id: 'fresh', title: '刚完成', displayTitle: '刚完成', blank: false, updatedAt: 1 },
        { id: 'old', title: '很久前完成', displayTitle: '很久前完成', blank: false, updatedAt: 2 },
        { id: 'broken', title: '旧失败', displayTitle: '旧失败', blank: false, updatedAt: 3 },
      ],
      {
        retentionMs: 30 * 60_000,
        sessions: {
          fresh: { lastTurnEnd: { kind: 'completed', at: now - 60_000 } },
          old: { lastTurnEnd: { kind: 'completed', at: now - 40 * 60_000 } },
          broken: { lastTurnEnd: { kind: 'error', message: '旧失败', at: now - 40 * 60_000 } },
        },
      },
      new Map([
        ['fresh', { running: false, pendingInteraction: undefined, completionUnread: true }],
        ['old', { running: false, pendingInteraction: undefined, completionUnread: true }],
        ['broken', { running: false, pendingInteraction: undefined, completionUnread: true }],
      ]),
      [],
      [],
      now,
    ),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: [],
  }))
  assert.ok(markup.includes('刚完成'))
  assert.equal(markup.includes('很久前完成'), false, '超过保留时长的绿色应被移除')
  assert.ok(markup.includes('旧失败'), '红色不受保留时长约束')
})

test('设置页从 configForms 读取并渲染字段（F-011 后为「外观」标签的字段）', async () => {
  const { registrations, configForm } = await registrationsOf()
  const config = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  const markup = renderToStaticMarkup(React.createElement(config.component, { ...hostProps, view: 'page' }))
  for (const key of [
    'settings.showFoldedCount.label',
    'settings.panelFrosted.label',
    'settings.panelOpacity.label',
    'settings.colorBlindMode.label',
    'settings.statusMarker.label',
    'settings.fontSizeMode.label',
    'settings.fontSizePx.label',
    'settings.autoSave',
  ]) {
    assert.ok(markup.includes(key), `settings view missing ${key}`)
  }
  // D-046：改动即时保存，所以页面上没有「保存 / 放弃修改」这对按钮 ——
  // 留着它们反而会让用户以为改完还没生效。
  assert.equal(markup.includes('>settings.save<'), false, '设置页不得再有保存按钮')
  assert.equal(markup.includes('>settings.discard<'), false, '设置页不得再有放弃修改按钮')
  assert.equal(configForm.getSnapshot().status, 'ready')
})

// F-011：设置页拆成三个标签，但 **FIELDS 仍是唯一清单** —— 它决定有哪些字段、
// 落在哪个标签；写入则统一交给 settings-writer。这条锁住「拆标签不得让任何字段
// 从写入路径消失」。
test('F-011：三个标签覆盖全部字段，且 FIELDS 仍是唯一 owner', async () => {
  const source = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.ok(/export const FIELD_GROUPS = \['appearance', 'motion', 'notify'\]/.test(source), '必须正好三组：外观/动效/通知')
  const fields = [...source.matchAll(/^\s{2}\{\s*field: '([a-zA-Z]+)'|^\s{4}field: '([a-zA-Z]+)',/gm)]
    .map((match) => match[1] ?? match[2])
    .filter((name) => name !== undefined)
  // 13 → 14 → 15：F-018 加 `ballSize`、F-019 加 `snapDistance`（用户 2026-11-01）。
  // 每次扩展都必须显式改这个数字，它挡的是「加了字段却忘了登记」。
  assert.equal(fields.length, 15, `FIELDS 必须仍登记 15 个字段，实得 ${fields.length}`)
  assert.ok(fields.includes('ballSize'), 'ballSize 必须在 FIELDS 里 —— 否则设置页没有它的控件')
  assert.ok(fields.includes('snapDistance'), 'snapDistance 必须在 FIELDS 里')
  for (const field of fields) {
    // 每个字段都必须落在某组里：漏写 group 会让它从所有标签页一起消失，
    // 但写入路径仍会碰它 —— 那是「看不见却被写」的最坏形状。
    const block = source.slice(source.indexOf(`field: '${field}'`), source.indexOf(`field: '${field}'`) + 420)
    assert.ok(/group: '(appearance|motion|notify)'/.test(block), `${field} 必须归入某一组`)
  }
  // 三组都必须非空，否则会出现一个空标签页。
  for (const group of ['appearance', 'motion', 'notify']) {
    const count = [...source.matchAll(new RegExp(`group: '${group}'`, 'g'))].length
    assert.ok(count > 0, `分组 ${group} 不能是空标签页`)
  }
  // 写入不受标签影响：每个控件直接调用唯一的 writer，而不是「先攒草稿、再按当前
  // 标签页保存」—— 后者在实时保存下会留下一条永远走不到的旧路径。
  const renderField = source.slice(source.indexOf('const renderField'), source.indexOf('// The failure is reported OUTSIDE'))
  assert.ok(/writer\.set\(/.test(renderField), '字段控件必须直接写 writer（实时保存）')
  assert.equal(/const save = async/.test(source), false, '设置页不得再有 save()：草稿-保存两段式已被 D-046 取代')
})

test('F-011：标签是真实 tablist/tab/tabpanel，且可键盘切换', async () => {
  const { registrations } = await registrationsOf()
  const config = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  const markup = renderToStaticMarkup(React.createElement(config.component, { ...hostProps, view: 'page' }))
  assert.ok(markup.includes('role="tablist"'), '必须有 tablist 角色')
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 3, '必须正好三个 tab')
  assert.ok(markup.includes('role="tabpanel"'), '必须有 tabpanel')
  assert.ok(markup.includes('aria-selected="true"'), '必须有被选中的标签')
  assert.ok(markup.includes('data-taskball-tab="appearance"'), '默认应停在外观标签')
  // 方向键切换是 tablist 的键盘契约；只有 onClick 的 div 是纯装饰。
  const source = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.ok(/ArrowRight/.test(source) && /ArrowLeft/.test(source), '标签必须支持方向键切换')
  assert.ok(/tabIndex: selected \? 0 : -1/.test(source), '必须用 roving tabindex，否则 Tab 会停在未选中的标签上')
})

// F-011 + D-046：切标签会卸载控件，所以「改到一半」的状态不能住在标签面板里。
// 现在只有数字输入需要文本草稿（打「1」是为了打到「13」），待写值本身由 writer
// 持有 —— 切标签、关浮层都不会丢，因为写已经发出去了。
test('F-011：切标签不丢待写状态，且失败提示跨标签可见', async () => {
  const source = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.ok(
    /const \[drafts, setDrafts\] = React\.useState/.test(source)
      && source.indexOf('const [drafts') < source.indexOf('const renderField'),
    '数字输入的文本草稿必须由页面持有，不得下沉到标签面板',
  )
  assert.ok(
    /from '\.\/settings-writer\.js'/.test(source),
    '待写值必须交给 writer（切标签会卸载持有它们的控件）',
  )
  const writer = await readFile(new URL('../src/client/settings-writer.ts', import.meta.url), 'utf8')
  assert.ok(/useSyncExternalStore/.test(writer), 'writer 必须可订阅，两个设置面共用同一份待写状态')
  const failedIndex = source.indexOf("view.failed ? h('div'")
  assert.ok(failedIndex > 0, '失败提示必须存在')
  const tail = source.slice(failedIndex)
  const panelClosePos = source.indexOf("fieldsInGroup(tab).map(renderField)")
  assert.ok(
    panelClosePos < failedIndex && tail.includes("t('settings.saveFailed')"),
    '失败提示必须在 tabpanel 之外 —— 否则它随面板卸载而消失',
  )
})

// D-046：实时保存之后，页面上不再有主按钮 —— D-045 那个「深色主题下白字白底」的
// 缺陷载体消失了。教训仍然成立（brand-primary 在深色主题是近白色），所以这里保留
// 「不得硬编码白色文字」这条不变量，另加一条：失败提示必须走宿主的 danger token。
test('D-046：设置页没有保存按钮，失败提示走宿主 danger token', async () => {
  const source = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.equal(/settings\.save'/.test(source), false, '设置页不得再出现保存按钮文案')
  assert.equal(/settings\.discard/.test(source), false, '设置页不得再出现放弃修改按钮文案')
  assert.ok(/--dsw-alias-label-danger/.test(source), '失败提示必须用宿主 danger token，不得硬编码颜色')
  assert.equal(
    /color: 'white'/.test(source),
    false,
    '不得硬编码白色文字 —— 深色主题的 brand-primary 就是近白色（D-045 的教训）',
  )
})

// D-046：写入路径的唯一 owner。这几条测的是行为而不是源码形状 —— 慢的根因是
// 每次写都会触发插件条目热重载（真机实测 1095ms / 2734ms），只能靠「本地先显示 +
// 合并写入 + 不带过期 revision」消掉；三者少一条就退回用户看到的样子。
function makeWriterForm(initial = { panelOpacity: 100 }, options = {}) {
  const calls = []
  const revisions = []
  let snapshot = {
    status: 'ready',
    value: { ...initial },
    base: options.base ?? {},
    revision: 7,
    writable: options.writable ?? true,
  }
  const listeners = new Set()
  const push = () => { for (const listener of listeners) listener() }
  return {
    calls,
    revisions,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, expectedRevision) {
      calls.push(JSON.parse(JSON.stringify(ops)))
      revisions.push(expectedRevision)
      if (options.gate !== undefined) await options.gate
      if (options.refuse === true) return false
      const value = { ...snapshot.value }
      for (const op of ops) {
        if (op.op === 'set') value[op.path[0]] = op.value
        else delete value[op.path[0]]
      }
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
      push()
      return true
    },
    __push(next) { snapshot = { ...snapshot, ...next }; push() },
  }
}

const oneTick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

test('D-046：改值立刻可见，不等 Host 回答', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm()
  const writer = client.__test__.createSettingsWriter(form, 5)
  writer.set('panelOpacity', 42)
  assert.equal(writer.getSnapshot().values.panelOpacity, 42, '控件一动就必须显示新值，不能等 1–2.7s 的插件热重载')
  assert.equal(writer.getSnapshot().pending, 1)
  assert.equal(form.calls.length, 0, '合并窗口内不得已经发出写入')
  await writer.flush()
  assert.deepEqual(form.calls, [[{ op: 'set', path: ['panelOpacity'], value: 42 }]])
  assert.equal(writer.getSnapshot().pending, 0, 'Host 回答后待写值必须清空')
})

test('D-046：连续改动合并成一次写，且以最后一次为准', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm()
  const writer = client.__test__.createSettingsWriter(form, 5)
  for (const value of [90, 80, 70, 60, 50]) writer.set('panelOpacity', value)
  await writer.flush()
  assert.equal(form.calls.length, 1, '一次拖动只能产生一次写 —— 每次写都是一次插件热重载')
  assert.deepEqual(form.calls[0], [{ op: 'set', path: ['panelOpacity'], value: 50 }], '写入必须是最新值')
})

test('D-046：写入不携带 expectedRevision（否则排队的写入会被判 stale）', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm()
  const writer = client.__test__.createSettingsWriter(form, 5)
  writer.set('panelOpacity', 60)
  writer.set('panelFrosted', true)
  await writer.flush()
  assert.deepEqual(form.revisions, [undefined], '必须让 Host 无条件写入 —— 排队前读到的 revision 已经过期')
  assert.equal(form.calls[0].length, 2, '同一批改动必须合成一次原子写')
})

test('D-046：写入被拒时回退到 Host 值并报告失败', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm({ panelOpacity: 100 }, { refuse: true })
  const writer = client.__test__.createSettingsWriter(form, 5)
  writer.set('panelOpacity', 30)
  assert.equal(writer.getSnapshot().values.panelOpacity, 30)
  await writer.flush()
  assert.equal(writer.getSnapshot().values.panelOpacity, 100, '被拒后必须回到 Host 的真实值，不能假装存住了')
  assert.equal(writer.getSnapshot().failed, true)
  assert.equal(writer.getSnapshot().pending, 0)
})

test('D-046：飞行中再改值不丢，排到下一批', async () => {
  const { client } = await registrationsOf()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const form = makeWriterForm({ panelOpacity: 100 }, { gate })
  const writer = client.__test__.createSettingsWriter(form, 1)
  writer.set('panelOpacity', 50)
  const first = writer.flush()
  while (form.calls.length === 0) await oneTick()
  writer.set('panelOpacity', 40)
  assert.equal(writer.getSnapshot().values.panelOpacity, 40, '飞行中仍要显示最新意图')
  release()
  await first
  await writer.flush()
  assert.equal(form.calls.length, 2, '飞行中的改动必须排进下一批，不得丢弃')
  assert.deepEqual(form.calls[1], [{ op: 'set', path: ['panelOpacity'], value: 40 }])
})

test('D-046：恢复默认发 unset，并立即显示组合基础值', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm({ panelOpacity: 40 }, { base: { panelOpacity: 100 } })
  const writer = client.__test__.createSettingsWriter(form, 5)
  writer.restoreDefault('panelOpacity')
  assert.equal(writer.getSnapshot().values.panelOpacity, 100, '重置后必须显示 base（schema 默认），而不是旧值')
  await writer.flush()
  assert.deepEqual(form.calls[0], [{ op: 'unset', path: ['panelOpacity'] }])
})

test('D-046：同一个 form 只对应一个 writer（两个设置面共用一条写队列）', async () => {
  const { client } = await registrationsOf()
  const form = makeWriterForm()
  assert.equal(client.__test__.settingsWriterFor(form), client.__test__.settingsWriterFor(form))
})

// 用户 2026-10-29：不透明度改成滑块，上下限 30 / 100。
// 滑块必须带可见数值 —— 只有滑杆看不出「具体多少」，而保存前必须能读到要存的值。
test('设置页不透明度是 range 滑块，上下限 30–100 且带可见数值', async () => {
  const source = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  const block = source.slice(
    source.indexOf("field: 'panelOpacity'"),
    source.indexOf("field: 'panelOpacity'") + 400,
  )
  assert.ok(/kind:\s*'range'/.test(block), '不透明度必须是 range 控件')
  assert.ok(/min:\s*30/.test(block), '下限必须是 30')
  assert.ok(/max:\s*100/.test(block), '上限必须是 100')
  assert.equal(/kind:\s*'number'/.test(block), false, '不得同时保留 number 控件')

  // range 与 number 共用同一条解析分支 —— 换控件不得改变存进 Host 的值
  const parse = source.slice(source.indexOf('function parseField'), source.indexOf('/** Subscribe to one shared config form'))
  assert.ok(/spec\.kind === 'range'|kind === 'select'/.test(parse), 'range 必须复用数值解析')
  assert.equal(/Number\.isFinite/.test(parse), true, 'range 取值仍必须过有限性校验')
})

// F-003（D-035）：外点关闭面板。三层链路少一层就静默失效；关闭必须走唯一的
// closePanel，否则球不会反向旋转；监听必须 passive，否则会吞掉宿主的点击。
test('F-003：外点关闭贯穿 schema / 设置页 / 客户端，且关闭走唯一 closePanel', async () => {
  const host = await readFile(new URL('../src/host/config.ts', import.meta.url), 'utf8')
  assert.ok(
    /closeOnOutsideClick:\s*z\.boolean\(\)\.default\(true\)\.volatile\(\)/.test(host),
    'Host schema 必须声明 closeOnOutsideClick，且默认 true',
  )
  const settings = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.ok(settings.includes("field: 'closeOnOutsideClick'"), '设置页必须暴露该开关')

  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(/settings\.closeOnOutsideClick !== false/.test(index), '客户端必须读该设置（缺失按开启处理）')
  assert.ok(
    /addEventListener\('pointerdown', onPointerDown, \{ capture: true, passive: true \}\)/.test(index),
    '外点监听必须 capture + passive',
  )
  const listenerBody = index.slice(index.indexOf('const onPointerDown'), index.indexOf('const onPointerDown') + 900)
  assert.equal(/preventDefault/.test(listenerBody), false, '外点监听不得 preventDefault —— 否则会吞掉宿主点击')
  assert.ok(/closePanelRef\.current\(\)/.test(index), '外点关闭必须走唯一的 closePanel')
  assert.ok(
    /\[data-taskball-panel\], \[data-taskball-ball\], \[data-taskball-bubble\]/.test(index),
    '球 / 面板 / 气泡上的点击不能算「外点」',
  )
})

test('设置页在 config 尚未就绪时显示加载态而不是空表单', async () => {  const { registrations } = await registrationsOf({ status: 'loading', value: undefined, revision: undefined })
  const config = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  const markup = renderToStaticMarkup(React.createElement(config.component, { ...hostProps, view: 'page' }))
  assert.ok(markup.includes('settings.loading'))
})

test('设置 summary 视图只渲染一行摘要', async () => {
  const { registrations } = await registrationsOf()
  const config = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  const markup = renderToStaticMarkup(React.createElement(config.component, { ...hostProps, view: 'summary' }))
  assert.ok(markup.includes('settings.summary'))
  assert.equal(markup.includes('settings.save'), false)
})

test('Client 注入清单不硬依赖 connection（缺失时球仍渲染）', async () => {
  const { client } = await registrationsOf()
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'uiWorkspace', 'configForms'])
})

// B-003：`configForms.get()` 返回的是 provider 持有的共享单例。本插件若在自己的
// fiber 里 dispose 它，provider 的 Map 仍留着这个死实例，下一次 `get()` 原样交回，
// 而它的 derive 订阅已经摘除 —— revision 冻住，之后每次写入都被当成 stale 冲突，
// 设置页永久「保存失败」。真机实测 revision 停在 2 而 Host 已到 5。
//
// 断言的是「整个 fiber 走完 teardown 之后」form 仍未被销毁，而不是「apply 期间没
// 调用 dispose」—— 后者在 disposer 模式下同样成立，抓不到这个 bug。
test('本插件不得销毁 configForms 的共享 form（B-003 回归）', async () => {
  const { effectDisposers, configForm } = await registrationsOf()
  assert.ok(effectDisposers.length > 0, 'fiber 应当注册了 effect')
  for (const teardown of effectDisposers) teardown()
  assert.deepEqual(configForm.disposeCalls, [])
})

test('悬浮球扇形按颜色分段，空态回退灰底', async () => {
  const { client } = await registrationsOf()
  const ball = client.__test__.TaskballBall
  const entry = (id, color) => ({ id, title: id, color, workspaceId: undefined, updatedAt: 0, completedAt: undefined })

  const markup = renderToStaticMarkup(React.createElement(ball, {
    entries: [entry('a', 'red'), entry('b', 'blue')],
    expanded: false,
    folded: new Set(),
    onToggle: () => {},
    t,
  }))
  assert.ok(markup.includes('conic-gradient'))
  assert.ok(markup.includes('#f16662'), '红色扇区（v4.4 调色板）')
  assert.ok(markup.includes('#52a7ff'), '蓝色扇区（v4.4 调色板）')
  assert.ok(markup.includes('ball.summary'))

  const empty = renderToStaticMarkup(React.createElement(ball, {
    entries: [],
    expanded: false,
    folded: new Set(),
    onToggle: () => {},
    t,
  }))
  // 空态是灰环而不是「无背景」：球必须始终可见，所以它同样由 conic-gradient 绘制。
  assert.ok(empty.includes('conic-gradient'))
  assert.ok(empty.includes('#c3ccd9'), '空态回退到中性灰')
  assert.equal(empty.includes('#f16662'), false, '空态不应出现任务色')
  assert.ok(empty.includes('ball.empty'))
})

test('气泡总开关：关闭则一律不弹，开启则红/黄/绿都弹（用户 2026-11-03，推翻 D-009 / D-056b）', async () => {
  const client = await loadClient()
  const transitionsOf = client.__test__.transitionsOf
  // The ball runs inside the vm realm, so its objects carry that realm's
  // prototypes; compare by value rather than by reference identity.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const previous = new Map([['a', 'blue'], ['b', 'blue'], ['c', 'blue']])
  const current = new Map([['a', 'red'], ['b', 'yellow'], ['c', 'green']])

  // Master switch off: NOTHING fires, not even a failure. This is the point of
  // the change — red used to be unsilenceable.
  assert.deepEqual(plain(transitionsOf(previous, current, false)), [])
  // On: all three colours announce.
  assert.deepEqual(plain(transitionsOf(previous, current, true)).map((item) => item.to), ['red', 'yellow', 'green'])

  // 非蓝起点不弹：绿→灰是已读，红→黄是同一条未了结的事。
  assert.deepEqual(plain(transitionsOf(new Map([['a', 'green']]), new Map([['a', 'gray']]), true)), [])
  assert.deepEqual(plain(transitionsOf(new Map([['a', 'red']]), new Map([['a', 'yellow']]), true)), [])
  // 首次观测没有前一帧，不能凭空弹。
  assert.deepEqual(plain(transitionsOf(new Map(), new Map([['a', 'red']]), true)), [])
})

test('气泡靠右边缘时翻到球的左侧（D-009）', async () => {
  const client = await loadClient()
  const bubbleSide = client.__test__.bubbleSide
  assert.equal(bubbleSide({ x: 100, y: 100 }, 1200), 'right')
  assert.equal(bubbleSide({ x: 1100, y: 100 }, 1200), 'left')
  assert.equal(bubbleSide(undefined, 1200), 'left')
})

test('悬浮球位置限制在视口内', async () => {
  const client = await loadClient()
  const clampPosition = client.__test__.clampPosition
  assert.deepEqual({ ...clampPosition({ x: -500, y: -500 }, 1200, 800) }, { x: 12, y: 12 })
  const far = clampPosition({ x: 9999, y: 9999 }, 1200, 800)
  assert.ok(far.x <= 1200 - 44)
  assert.ok(far.y <= 800 - 44)
})

// F-007：吸附。需求原文给了三类目标 —— 左右侧栏与主对话的分界线、对话区两侧、
// 视口四边。分界线不是猜的坐标：宿主 AppFrame 的**中心列**左边界就是侧栏分界、
// 右边界就是右栏分界。这里只测纯函数，真机行为（拖到线附近是否贴上去、折叠侧栏
// 是否跟随）在 testing-manual T-21 验。
//
// 锚点在 2026-10-31 更正（D-063）：此前读 `[data-dsh-center-col]`，那个属性由
// **第三方插件 dsh-better-sidebar 运行时注入**，不是宿主契约 —— 它被禁用/升级/
// 换台机器没装，吸附就静默退化。官方锚点是 `[data-rightbar-col]`
// （dsh-client-ui-layout 的 RightbarColumn 注入），它的 previousElementSibling
// 正是中心列，一个关系同时给出左右两条线。
test('F-007：吸附目标 = 中心列两条分界线 + 视口四边，不硬编码侧栏宽度', async () => {
  const client = await loadClient()
  const { snapTargets, readCenterColumn } = client.__test__
  const targets = snapTargets({ left: 280, right: 1415 }, 1695, 930)
  const kinds = [...targets.x.map((target) => target.kind)]
  assert.deepEqual(kinds, ['left', 'sidebar', 'rightbar', 'right'])
  const sidebar = targets.x.find((target) => target.kind === 'sidebar')
  assert.equal(sidebar.position, 286, '侧栏线 = 中心列左边界 + 6px 间隙（不覆盖宿主 8px 的 resize handle）')
  const rightbar = targets.x.find((target) => target.kind === 'rightbar')
  assert.equal(rightbar.position, 1415 - 44 - 6, '右栏线 = 中心列右边界 - 球宽 - 间隙')
  assert.deepEqual([...targets.y.map((target) => target.kind)], ['top', 'bottom'])
  // 读不到宿主布局时必须降级成只有四边，而不是把球锁死在某条线上。
  const bare = snapTargets(readCenterColumn({ querySelector: () => null }), 1200, 800)
  assert.deepEqual([...bare.x.map((target) => target.kind)], ['left', 'right'])
  assert.deepEqual({ ...readCenterColumn(undefined) }, {})
  // 宿主 DOM 依赖只认 data 属性；哈希类名每次宿主构建都变，拿来当选择器必坏。
  const rect = { left: 300, right: 1000, width: 700 }
  const centerStub = { getBoundingClientRect: () => rect }
  const readFrom = (selector) => (selector === '[data-rightbar-col]'
    ? { previousElementSibling: centerStub }
    : null)
  assert.deepEqual(
    { ...readCenterColumn({ querySelector: readFrom }) },
    { left: 300, right: 1000 },
    '中心列由官方 [data-rightbar-col] 的前一个兄弟推出来',
  )
  // 第三方注入的 data-dsh-center-col 不得再被当作锚点（它可能根本不存在）。
  assert.deepEqual(
    { ...readCenterColumn({ querySelector: (selector) => (selector === '[data-dsh-center-col]' ? centerStub : null) }) },
    {},
    '不得再依赖第三方注入的 data-dsh-center-col',
  )
  // 中心列宽度为 0 = 还没布局完，报成吸附线会把球钉在 x=0。
  assert.deepEqual(
    { ...readCenterColumn({ querySelector: () => ({ previousElementSibling: { getBoundingClientRect: () => ({ left: 0, right: 0, width: 0 }) } }) }) },
    {},
  )
})

test('F-007：阈值内才吸附，两轴独立，拖远不粘', async () => {
  const client = await loadClient()
  const { snapPosition, SNAP_DISTANCE } = client.__test__
  const targets = client.__test__.snapTargets({ left: 280, right: 1415 }, 1695, 930)
  // x 落在阈值内：贴侧栏线；y 离两条边都远：保持原值。
  const nearLine = snapPosition({ x: 286 + SNAP_DISTANCE - 1, y: 500 }, targets)
  assert.deepEqual({ ...nearLine.position }, { x: 286, y: 500 })
  assert.equal(nearLine.attachment.x, 'sidebar')
  assert.equal(nearLine.attachment.y, undefined)
  // 两轴各自判定：靠底边同时靠左。
  const corner = snapPosition({ x: 12 + 4, y: 930 - 44 - 12 + 5 }, targets)
  assert.deepEqual({ ...corner.position }, { x: 12, y: 930 - 44 - 12 })
  assert.equal(corner.attachment.x, 'left')
  assert.equal(corner.attachment.y, 'bottom')
  // 中间地带：一个都不吸，且不带任何 attachment。
  const free = snapPosition({ x: 800, y: 400 }, targets)
  assert.deepEqual({ ...free.position }, { x: 800, y: 400 })
  assert.deepEqual({ ...free.attachment }, { x: undefined, y: undefined })
})

test('F-007：布局变化只带走「已吸附」的球，自由球位置不被覆盖', async () => {
  const client = await loadClient()
  const { followAttachment, snapTargets } = client.__test__
  const collapsed = snapTargets({ left: 0, right: 1695 }, 1695, 930)
  const attached = followAttachment({ x: 'sidebar' }, collapsed, { x: 700, y: 300 })
  assert.equal(attached.x, 6, '侧栏收起后球跟着贴到新的分界线')
  assert.equal(attached.y, 300, '只有吸附的那一轴动')
  const free = followAttachment({}, collapsed, { x: 700, y: 300 })
  assert.deepEqual({ ...free }, { x: 700, y: 300 }, '自由球不得被布局变化移走')

  // 吸附意图随位置一起落 localStorage：刷新后仍贴着线；旧格式（只有 x/y）读成自由球。
  const { writePlacement, readPlacement } = client.__test__
  writePlacement({ position: { x: 286, y: 300 }, attachment: { x: 'sidebar' } })
  const stored = readPlacement()
  assert.deepEqual({ ...stored.position }, { x: 286, y: 300 })
  assert.equal(stored.attachment.x, 'sidebar')
  assert.equal(stored.attachment.y, undefined)
  const storage = client.__storage
  assert.ok(storage !== undefined, '测试沙箱必须提供 localStorage')
  storage.set('dsh-useful-taskball:ball-position', JSON.stringify({ x: 40, y: 50 }))
  const legacy = readPlacement()
  assert.deepEqual({ ...legacy.position }, { x: 40, y: 50 })
  assert.deepEqual({ ...legacy.attachment }, { x: undefined, y: undefined }, '旧格式必须读成自由球，不得瞎猜吸附')
})

test('悬浮球与中心盘必须显式 round，否则宿主全局 superellipse 会把它压成圆角矩形', async () => {
  const { client } = await registrationsOf()
  const ball = client.__test__.TaskballBall
  const markup = renderToStaticMarkup(React.createElement(ball, {
    entries: [{ id: 'a', title: 'a', color: 'blue', workspaceId: undefined, updatedAt: 0, completedAt: undefined }],
    expanded: false,
    folded: new Set(),
    onToggle: () => {},
    t,
  }))
  // 宿主在全局设了 `corner-shape: superellipse(1.5)`；`border-radius: 50%` 单独存在时
  // 渲染出来是圆角矩形。任何圆形表面都必须显式覆盖回 round。
  const cornerShapes = markup.match(/corner-shape:\s*round/g) ?? []
  assert.ok(cornerShapes.length >= 2, `球体与中心盘都要声明 corner-shape:round，实际 ${cornerShapes.length} 处`)
  assert.equal(markup.includes('corner-shape:superellipse'), false)
})

// 用户 2026-10-30 报：「球的中心点处始终有一个点，这个能不能去掉」。
// 那不是磨砂玻璃盘（用户明确要留），而是空态时额外叠的一个 `·` 字符占位 ——
// 它和中心盘叠在一起，看起来就是盘上多了一个点。
test('闲置球不得再有 `·` 占位点，但磨砂玻璃盘必须保留', async () => {
  const { client } = await registrationsOf()
  const ball = client.__test__.TaskballBall
  const empty = renderToStaticMarkup(React.createElement(ball, {
    entries: [],
    expanded: false,
    folded: new Set(),
    onToggle: () => {},
    t,
  }))
  assert.equal(empty.includes('·'), false, '空态不得再渲染 `·` 占位字符 —— 用户看到的就是那个「中心点」')
  // 磨砂盘（16px 玻璃心）是设计的一部分，用户明确要求保留
  assert.ok(empty.includes('backdrop-filter:blur(2px)'), '磨砂玻璃盘必须保留（用户明确要求）')

  const withTasks = renderToStaticMarkup(React.createElement(ball, {
    entries: [{ id: 'a', title: 'a', color: 'blue', workspaceId: undefined, updatedAt: 0, completedAt: undefined }],
    expanded: false,
    folded: new Set(),
    onToggle: () => {},
    t,
  }))
  assert.equal(withTasks.includes('·'), false, '有任务时同样不得出现 `·`')
})

test('面板里的状态点同样是真圆', async () => {
  const { client } = await registrationsOf()
  const panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(panel, {
    expanded: true,
    view: panelView([sessionsState.byId.s1], emptyHost, statusMap, []),
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
    t,
    workspaces: [],
  }))
  assert.ok((markup.match(/corner-shape:\s*round/g) ?? []).length >= 2, '状态点与颜色图例都要 round')
})

test('旋转 transition 只能挂在 data-spin 上，否则球会转完再倒转回去', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 实测：transition 写在基础规则里时，清除 data-spin 会让 transform 从
  // rotate(360deg) 动画回 none，用户看到「转一圈又倒回来」。
  const baseRule = css.match(/\[data-taskball-ball\]\s*\{[^}]*\}/)?.[0] ?? ''
  assert.ok(baseRule.length > 0, '找不到球的 CSS 基础规则')
  assert.equal(
    baseRule.includes('transition'),
    false,
    '基础规则不得带 transition —— 360deg 归位必须瞬时完成',
  )
  const spinRule = css.match(/\[data-taskball-ball\]\[data-spin\]\s*\{[^}]*\}/)?.[0] ?? ''
  assert.ok(spinRule.includes('transition'), '旋转态必须带 transition，否则球不转')
})

test('气泡是带尖角的聊天气泡：背景随状态色、尾巴指向球', async () => {
  const { client } = await registrationsOf()
  const bubble = client.__test__.TaskballBubble
  // 球在左侧 → 气泡在球右边，尾巴在气泡左边（朝向球）
  const markup = renderToStaticMarkup(React.createElement(bubble, {
    anchor: { x: 100, y: 300 },
    title: '修复登录',
    transition: { from: 'blue', id: 's1', to: 'red' },
    t,
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  // 背景色必须是转换后的状态色（红 #f16662 → rgb(241,102,98)）
  assert.ok(markup.includes('background:#f16662') || markup.includes('background: rgb(241, 102, 98)'), '气泡背景必须跟随状态色')
  // 必须有一个旋转 45° 的方形尾巴，且不能被宿主的 superellipse 磨圆
  assert.ok(markup.includes('rotate(45deg)'), '气泡必须有指向球的尖角')
  const tails = markup.match(/corner-shape:\s*round/g) ?? []
  assert.ok(tails.length >= 2, `气泡本体与尾巴都要 round，实际 ${tails.length} 处`)
  // 球在左半屏 → 气泡在球的右侧
  assert.ok(markup.includes('data-side="right"'), '球在左半屏时气泡应开在右侧')
})

// F10（用户 2026-10-28）：整体外侧一条连续线条；三角形移到正中间，
// 两个顶点不与气泡上下边缘重合（内缩），而不是贴着角。
test('气泡整体只有一条外轮廓，且尖角垂直居中（F10）', async () => {
  const { client } = await registrationsOf()
  const bubble = client.__test__.TaskballBubble
  const markup = renderToStaticMarkup(React.createElement(bubble, {
    anchor: { x: 100, y: 300 },
    title: 'x',
    transition: { from: 'blue', id: 's1', to: 'red' },
    t,
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  // 外轮廓来自 wrapper 的 drop-shadow：它描的是两个形状的并集，
  // 所以会顺着缺口走；border 做不到这点（会横穿接缝）。
  assert.ok(markup.includes('drop-shadow'), '外轮廓必须用 drop-shadow 描并集，而不是 border')
  assert.ok(!markup.includes('border:1px solid rgba(15, 23, 42, 0.16)'), 'wrapper 不得再画 border，否则接缝会出现一条线')
  // 尖角用 top:50% + translateY(-50%) 居中，纯 CSS 不测量、不会震荡
  assert.ok(markup.includes('translateY(-50%) rotate(45deg)'), '尖角必须垂直居中且在中心旋转')
  assert.ok(markup.includes('top:50%'), '尖角必须锚在气泡垂直中线')
})

// F-015（用户 2026-11-01：「可以让那个三角形再小一些」，并指出轮廓太淡）：
// 尖角 7 → 5，描边 0.5px → 0.75px。
test('F-015：气泡尖角缩小到 5px，且渲染尺寸跟着变小', async () => {
  const { client } = await registrationsOf()
  const { TaskballBubble, TAIL } = client.__test__
  assert.equal(TAIL, 5, '尖角视觉尺寸必须是 5px（原来是 7）')

  const markup = renderToStaticMarkup(React.createElement(TaskballBubble, {
    anchor: { x: 100, y: 300 },
    title: 'x',
    transition: { from: 'blue', id: 's1', to: 'red' },
    t,
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  // 尖角是 TAIL*2 的旋转方块：5 → 10px。必须真的变，不能只改常量。
  assert.ok(markup.includes('height:10px'), `尖角方块高度必须是 10px（TAIL*2），实际输出里找不到`)
  assert.ok(markup.includes('width:10px'), '尖角方块宽度必须是 10px')
  assert.equal(/height:14px/.test(markup), false, '不得残留旧的 14px 尖角')
  // 露出一半 = 5px，所以左移/右移也是 5px
  assert.ok(/right:-5px|left:-5px/.test(markup), '尖角偏移必须跟着 TAIL 变成 5px')
})

test('F-015：气泡描边从 0.5px 加粗到 0.75px（1x 屏会被抗锯齿吃掉）', async () => {
  const { client } = await registrationsOf()
  const { TaskballBubble, BUBBLE_OUTLINE_PX } = client.__test__
  assert.equal(BUBBLE_OUTLINE_PX, 0.75, '描边必须是 0.75px —— 0.5px 在 1x DPR 下会被吃掉')

  const markup = renderToStaticMarkup(React.createElement(TaskballBubble, {
    anchor: { x: 100, y: 300 },
    title: 'x',
    transition: { from: 'blue', id: 's1', to: 'red' },
    t,
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  assert.ok(markup.includes('drop-shadow(0 0 0.75px'), '第一层 drop-shadow 必须是 0.75px 描边')
  // 投影那层还在：加粗描边不能顺手把阴影删了
  assert.ok(markup.includes('drop-shadow(0 6px 20px'), '柔光投影不得被删')
})

test('气泡靠近右边缘时翻到球左侧，尾巴随之换边', async () => {
  const { client } = await registrationsOf()
  const bubble = client.__test__.TaskballBubble
  const markup = renderToStaticMarkup(React.createElement(bubble, {
    anchor: { x: 1100, y: 300 },
    title: 'x',
    transition: { from: 'blue', id: 's1', to: 'yellow' },
    t,
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  assert.ok(markup.includes('data-side="left"'), '靠右边缘时必须翻到左侧')
})

test('面板贴在球旁边而不是固定角落', async () => {
  const { client } = await registrationsOf()
  const place = client.__test__.panelPlacement
  // 球在中下部 → 面板在球上方，底边贴球顶
  const above = place({ x: 300, y: 700 }, 1200, 800)
  assert.equal(above.left, 300, '面板左边缘对齐球的左边缘')
  assert.ok(above.bottom !== undefined, '上方空间足够时用 bottom 锚定')
  assert.equal(above.top, undefined, '不得同时设 top 与 bottom，否则面板被钉在视口顶部')
  // 球贴近顶部 → 改挂到球下方
  const below = place({ x: 300, y: 20 }, 1200, 800)
  assert.ok(below.top !== undefined && below.top > 20, '上方空间不足时应挂在球下方')
  // 球贴近右边缘 → 面板翻到球的左侧
  const flipped = place({ x: 1150, y: 700 }, 1200, 800)
  assert.ok(flipped.right !== undefined && flipped.left === undefined, '靠右边缘时面板翻到左侧')
})

// ── F-009 右键快捷设置 ────────────────────────────────────────────────────────

test('F-009：球右键打开快捷面板，且不改动主键路径', async () => {
  const source = await readFile(new URL('../src/client/ball.ts', import.meta.url), 'utf8')
  assert.ok(/onContextMenu/.test(source), '球必须挂 onContextMenu')
  const start = source.indexOf('const onContextMenu')
  const handler = source.slice(start, source.indexOf('const occupying', start))
  assert.ok(/preventDefault\(\)/.test(handler), '必须阻止浏览器原生菜单，否则两套菜单同时出现')
  assert.ok(/props\.onQuick/.test(handler), '右键必须走独立的 onQuick，不得复用 onToggle')
  // 主键路径的判定不能被右键语义污染：那个分支带着拖拽 vs 点击的决策。
  const pointerDown = source.slice(source.indexOf('const onPointerDown'), source.indexOf('const onKeyDown'))
  assert.ok(/event\.button !== 0/.test(pointerDown), '主键路径必须仍然只认 button 0')
  assert.equal(/onQuick/.test(pointerDown), false, 'onQuick 不得进入主键/拖拽路径')
})

test('F-009：Shift+F10 提供键盘等效入口', async () => {
  const { client } = await registrationsOf()
  const Ball = client.__test__.TaskballBall
  const markup = renderToStaticMarkup(React.createElement(Ball, {
    entries: [],
    expanded: false,
    folded: new Set(),
    onQuick() {},
    onToggle() {},
    t,
  }))
  assert.ok(markup.includes('aria-haspopup="dialog"'), '有快捷入口时球必须声明弹出目标是 dialog')
  const source = await readFile(new URL('../src/client/ball.ts', import.meta.url), 'utf8')
  const keydown = source.slice(source.indexOf('const onKeyDown'), source.indexOf('const onContextMenu'))
  assert.ok(/event\.shiftKey && event\.key === 'F10'/.test(keydown), '必须实现 Shift+F10 —— 否则快捷面板是鼠标专属')
})

test('F-009：快捷面板是独立浮层，磨砂与面板共用同一套材质 token', async () => {
  const { client } = await registrationsOf()
  const Quick = client.__test__.TaskballQuick
  const markup = renderToStaticMarkup(React.createElement(Quick, {
    anchor: { x: 300, y: 700 },
    onClose() {},
    onSet() {},
    t,
    values: { colorBlindMode: false, panelFrosted: false, panelOpacity: 100, statusMarker: 'bar' },
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  assert.ok(markup.includes('data-taskball-quick'), '快捷面板必须是自己的浮层（data-taskball-quick）')
  assert.ok(markup.includes('--dsw-menu-backdrop-filter'), '必须用宿主菜单材质，不得自造 blur')
  assert.ok(markup.includes('--dsw-specific-menu'), '必须用宿主菜单底色 token（跟随深色主题）')
  // 材质只有一个 owner：面板磨砂与快捷面板都从 material.ts 取，不能各写一份。
  const material = await readFile(new URL('../src/client/material.ts', import.meta.url), 'utf8')
  assert.ok(/MENU_BACKDROP_FILTER/.test(material) && /MENU_SURFACE_FILL/.test(material), '材质必须是共用常量')
  for (const file of ['panel.ts', 'quick.ts']) {
    const text = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    assert.ok(/from '\.\/material\.js'/.test(text), `${file} 必须从 material.ts 取材质（不得自造）`)
  }
})

test('F-009 / D-073：快捷面板改值走共享 form 且无保存按钮', async () => {
  const { client } = await registrationsOf()
  const Quick = client.__test__.TaskballQuick
  const markup = renderToStaticMarkup(React.createElement(Quick, {
    anchor: { x: 300, y: 700 },
    onClose() {},
    onOpenAllSettings() {},
    onSet() {},
    t,
    values: {
      ballSize: 'large',
      bubbleOnCompletion: false,
      fontSizeMode: 'host',
      fontSizePx: 13,
      panelFrosted: true,
      panelOpacity: 72,
      showFoldedSection: true,
    },
    viewportHeight: 800,
    viewportWidth: 1200,
  }))
  for (const key of [
    'settings.ballSize.label',
    'settings.panelFrosted.label',
    'settings.panelOpacity.label',
  ]) {
    assert.ok(markup.includes(key), `快捷面板缺 ${key}`)
  }
  // D-073 反向断言：这两项已从快捷面板移除
  assert.equal(markup.includes('settings.statusMarker.label'), false,
    'D-073：状态表示不得出现在快捷面板')
  assert.equal(markup.includes('settings.colorBlindMode.label'), false,
    'D-073：色盲配色不得出现在快捷面板')
  assert.ok(markup.includes('data-taskball-quick-opacity'), '滑块必须带可见数值')
  assert.ok(markup.includes('72%'), '数值必须反映当前值')
  // 一个四项开关的菜单加「保存」按钮，等于让用户做两次决定。
  assert.equal(/settings\.save/.test(markup), false, '快捷面板不得有保存按钮（改值即写）')
  assert.ok(/quick\.openAll/.test(markup), '必须给「打开全部设置」出口，否则 13 项里 9 项无路可走')
})

test('F-009：外点关闭只有一个监听 owner，选择器覆盖全部四层', async () => {
  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // 铁律 11：两个全局监听就是在「算不算外点」这件事上有两个 owner。
  assert.equal((index.match(/addEventListener\('pointerdown', onPointerDown/g) ?? []).length, 1, '外点监听必须只有一处')
  const selector = index.slice(index.indexOf('const INSIDE_SELECTOR'), index.indexOf("const INSIDE_SELECTOR") + 400)
  for (const layer of ['data-taskball-panel', 'data-taskball-ball', 'data-taskball-bubble', 'data-taskball-quick']) {
    assert.ok(selector.includes(layer), `外点选择器必须包含 ${layer}，否则点它会误关`)
  }
  // 关闭两个层时仍不得吞掉宿主点击。
  assert.ok(/capture: true, passive: true/.test(index), '外点监听必须 capture + passive')
})

test('F-009：面板首行提供「快捷设置」入口（触控板/键盘第一次可达）', async () => {
  const { client } = await registrationsOf()
  const Panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(Panel, {
    expanded: true,
    onClose() {},
    onOpenQuick() {},
    onOpenSession() {},
    onToggleFolded() {},
    t,
    view: panelView(
      [{ id: 's1', title: '修复登录', displayTitle: '修复登录', blank: false, updatedAt: 1 }],
      emptyHost,
      new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]),
    ),
    workspaces: workspaceState.items,
  }))
  assert.ok(markup.includes('data-taskball-quick-trigger'), '面板必须提供快捷设置入口')
  assert.ok(markup.includes('aria-label="panel.quickSettings"'), '入口必须有可访问名称')
  // 没有该能力时必须整块消失，而不是留下一个点了没反应的齿轮。
  const without = renderToStaticMarkup(React.createElement(Panel, {
    expanded: true,
    onClose() {},
    onOpenSession() {},
    onToggleFolded() {},
    t,
    view: panelView([], emptyHost),
    workspaces: [],
  }))
  assert.equal(without.includes('data-taskball-quick-trigger'), false, '无入口能力时不得渲染齿轮')
})

// F-022（用户 2026-11-03）：首行两个控件从「文本字符」换成宿主图标。
//
// 为什么必须断言「字符消失」而不是只断言「有 svg」：只加不删会让齿轮字符与
// SVG 叠在一起，而「有没有 svg」这类断言照样能过 —— 那正是本仓库 §13
// 「门禁没红但变异确实发生了」的第 ② 种成因（断言写得太松）。
test('F-022：首行的齿轮与关闭都是宿主图标，文本字符已消失', async () => {
  const { client } = await registrationsOf()
  const Panel = client.__test__.TaskballPanel
  const markup = renderToStaticMarkup(React.createElement(Panel, {
    expanded: true,
    onClose() {},
    onOpenQuick() {},
    onOpenSession() {},
    onToggleFolded() {},
    t,
    view: panelView([], emptyHost),
    workspaces: [],
  }))

  assert.equal(markup.includes('⚙'), false, '首行不得再出现 ⚙ 文本字符（F-022 已换成宿主图标）')
  assert.equal(markup.includes('>×<'), false, '关闭按钮不得再是 × 文本字符')

  // 两个控件各一个 svg，且都是宿主的 16×16 视口。
  // 切片必须用「闭合的稳定边界」：从入口属性到关闭按钮的 aria-label，从关闭按钮
  // 到 body 结束。用「从这里到字符串末尾」会让关闭图标的断言把后面的行也切进来，
  // path 计数虚高 —— 少一条 path 也照样过（负向验证第 ⑥ 条抓出过这个漏检）。
  const gearSvg = markup.slice(markup.indexOf('data-taskball-quick-trigger'), markup.indexOf('aria-label="panel.close"'))
  assert.ok(gearSvg.length > 0, '齿轮的切片不得为空（否则下面的断言会空转通过）')
  assert.ok(gearSvg.includes('viewBox="0 0 16 16"'), '齿轮必须是宿主的 16×16 视口')
  assert.ok(gearSvg.includes('stroke-width="1.3"'), '齿轮必须是 Medium 粗细 1.3（与宿主账户菜单一致）')
  assert.equal((gearSvg.match(/<path/g) ?? []).length, 2, '宿主齿轮是两条 path（中心圆 + 外轮廓）')
  assert.ok(gearSvg.includes('stroke-miterlimit="10"'), '齿轮外轮廓必须带 strokeMiterlimit 10')

  const closeStart = markup.indexOf('aria-label="panel.close"')
  const closeSvg = markup.slice(closeStart, markup.indexOf('data-taskball-counts', closeStart) === -1
    ? markup.indexOf('</div>', closeStart)
    : markup.indexOf('data-taskball-counts', closeStart))
  assert.ok(closeSvg.length > 0, '关闭图标的切片不得为空')
  assert.ok(closeSvg.includes('viewBox="0 0 16 16"'), '关闭图标也必须是宿主视口')
  assert.ok(closeSvg.includes('stroke-width="1.3"'), '关闭图标必须与齿轮同档粗细，否则两个控件又不像一对')
  assert.equal((closeSvg.match(/<path/g) ?? []).length, 2, '宿主关闭图标是两条交叉 path')

  // 无障碍契约不得因换图标而丢。
  assert.ok(markup.includes('aria-label="panel.quickSettings"'), '入口的可访问名称必须保留')
  assert.ok(markup.includes('aria-label="panel.close"'), '关闭按钮的可访问名称必须保留')
})

test('F-009：快捷面板换边与限高，不越出视口', async () => {
  const { client } = await registrationsOf()
  const place = client.__test__.quickPlacement
  const above = place({ x: 300, y: 700 }, 1200, 800)
  assert.ok(above.bottom !== undefined && above.top === undefined, '上方有空间时用 bottom 锚定')
  assert.equal(above.left, 300, '左边缘对齐球')
  const below = place({ x: 300, y: 20 }, 1200, 800)
  assert.ok(below.top !== undefined && below.bottom === undefined, '上方空间不足时挂到球下方')
  const flipped = place({ x: 1150, y: 700 }, 1200, 800)
  assert.ok(flipped.right !== undefined && flipped.left === undefined, '靠右边缘时翻到球左侧')
  // 320px 窄屏：面板宽 248，贴右时 left 会被夹进视口。
  const narrow = place({ x: 200, y: 700 }, 320, 800)
  assert.ok(narrow.left === undefined || narrow.left <= 320 - 248, '窄屏下不得溢出视口右侧')
})

// 真机实测（2026-10-29）：快捷面板实测 273.3px，而定位逻辑按 248px 计算 ——
// 默认 content-box 把 12px padding 与 1px border 加在了 width 之外。结果是它
// 靠右边缘时能溢出视口 25px，而换边判定仍然「以为」它放得下。
// 布局常量只有在盒子宽度等于该常量时才有意义。
test('F-009：快捷面板必须 border-box，否则实测宽度超出定位常量', async () => {
  const source = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  assert.ok(/boxSizing: 'border-box'/.test(source), '快捷面板必须 border-box —— 否则 QUICK_WIDTH 与真实宽度不符')
  // 有 padding/border 时 content-box 必定变宽：两者必须同时成立才算对齐。
  assert.ok(/padding: 12/.test(source), '面板有内边距，故必须 border-box')
  assert.ok(/border: '1px solid/.test(source), '面板有描边，故必须 border-box')
})

// 真机实测（2026-10-29）：第一版的「打开全部设置」导航的是设置对话框（Settings →
// 内置插件），那里面**根本没有**本插件的配置页 —— 它注册在 plugin-manager 的
// `main` 面板（key=plugins）里。对话框能弹出来，看起来成功，实际是死路。
// 这条锁住：必须走 layout.selectPanel + plugin-manager 自己的导航 store。
test('F-009：打开全部设置必须落在 plugin-manager 面板，不是设置对话框', async () => {
  const { client } = await registrationsOf()
  const openPluginSettings = client.__test__.openPluginSettings
  const pluginManagerNavigation = client.__test__.pluginManagerNavigation

  // 没有 slots / layout：宿主没有插件页，必须明确返回 false（调用方据此隐藏入口）。
  assert.equal(pluginManagerNavigation(undefined), undefined)
  assert.equal(openPluginSettings({}), false, '无任何路由时必须返回 false')

  const views = []
  const panels = []
  const navigation = { actions: { setView: (view) => { views.push(view) } } }
  const slots = {
    entries: (key) => (key === 'main' ? [{ options: { key: 'plugins' }, store: { create: () => navigation } }] : []),
  }
  const layout = { selectPanel: (id) => { panels.push(id) } }

  assert.equal(pluginManagerNavigation(slots), navigation)
  assert.equal(openPluginSettings({ layout, slots }), true)
  // The plugin runs inside the vm realm, so its arrays carry that realm's
  // prototypes; compare by value rather than by reference identity (same
  // convention as transitionsOf above).
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(panels), ['plugins'], '必须选中 plugin-manager 面板 —— 配置页只在那里挂载')
  assert.deepEqual(
    plain(views),
    [{ kind: 'package', name: 'dsh-useful-taskball' }],
    '必须直接打开本插件的包页，而不是列表',
  )

  // 缺任意一半都必须失败，不能「点了一半」。
  assert.equal(openPluginSettings({ layout }), false, '缺插件页时必须 false')
  assert.equal(openPluginSettings({ slots }), false, '缺 layout 时必须 false')
  // store.create 抛错不得把整个 overlay 带下去。
  const broken = { entries: () => { throw new Error('boom') } }
  assert.equal(pluginManagerNavigation(broken), undefined)
  assert.equal(openPluginSettings({ layout, slots: broken }), false)
  // 有 main 槽但没有 setView 的实例同样不算可用路由。
  const inert = {
    entries: (key) => (key === 'main' ? [{ options: { key: 'plugins' }, store: { create: () => ({}) } }] : []),
  }
  assert.equal(pluginManagerNavigation(inert), undefined)
})

// 第一版的错误路由留下的教训必须钉在源码里：导入设置 shell 的座位/命令就是回到死路。
test('F-009：不得再用设置对话框路由（它不含本插件配置页）', async () => {
  const source = await readFile(new URL('../src/client/open-settings.ts', import.meta.url), 'utf8')
  assert.equal(/sidebar\.settings/.test(source), false, '不得导航设置对话框 —— 那里面没有本插件的配置页')
  assert.equal(/settings\.open/.test(source), false, '不得调用 settings.open 命令（同上）')
  assert.ok(/MAIN_SLOT = 'main'/.test(source), '必须从 main 槽读 plugin-manager 的面板')
  assert.ok(/kind: 'package'/.test(source), '必须直接打开包页，否则用户还要自己点一次')
})
