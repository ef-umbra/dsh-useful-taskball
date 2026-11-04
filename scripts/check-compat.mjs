import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Count every gate as it runs, so the reported total can never drift from the
 * real one. The previous hand-maintained `checks.length + 18` silently went
 * stale the moment gates were added.
 */
let gateCount = 0
const counted = {
  ok: (...args) => { gateCount += 1; return assert.ok(...args) },
  equal: (...args) => { gateCount += 1; return assert.equal(...args) },
  deepEqual: (...args) => { gateCount += 1; return assert.deepEqual(...args) },
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const localDsh = path.join(root, 'node_modules/@deepseek-ai/dsh')
// Resolve the installed DSH without hard-coding a machine path: `DSH_CHECKOUT`
// wins, then the global npm root, then `npm prefix -g`. A literal absolute path
// here would leak the author's username into the published source.
function globalDshRoot() {
  if (process.env.DSH_CHECKOUT !== undefined) return process.env.DSH_CHECKOUT
  const candidates = []
  const execPath = process.execPath
  // <node>/node_modules/npm/... → <prefix>/node_modules
  const prefix = path.dirname(path.dirname(execPath))
  candidates.push(path.join(prefix, 'node_modules/@deepseek-ai/dsh'))
  candidates.push(path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh'))
  return candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')))
}
const globalDsh = globalDshRoot()

let dshRoot = localDsh
try {
  await access(path.join(localDsh, 'package.json'))
} catch {
  dshRoot = globalDsh
}

const dshManifest = JSON.parse(await readFile(path.join(dshRoot, 'package.json'), 'utf8'))
const packages = path.join(dshRoot, 'node_modules/@deepseek-ai')
const checks = [
  ['dsh-client-ui-session/lib/types/client/index.d.ts', ['readonly running:', 'readonly pendingInteraction:', 'readonly completionUnread:']],
  ['dsh-session/lib/types/types.d.ts', ['export interface TurnEndReasonMap', "kind: 'interrupted'", "kind: 'blocked'", 'export type TurnEndCancelCause']],
  ['dsh-client-ui-workspace/lib/types/client/tree.d.ts', ['export declare function deriveGroups', 'export interface SessionNode']],
  ['dsh-client-ui-workspace/lib/types/client/navigation.d.ts', ['openSession(target: SessionTarget): void']],
  ['dsh-cordis-client-runner/lib/client.js', ['key: "shell.overlay"']],
  ['dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts', ["'plugins.bundle.config'", 'export interface ConfigPageForm']],
  ['dsh-client-ui-settings/lib/types/client/config-form-types.d.ts', ['export interface ConfigFormSnapshot', 'export interface ConfigForm']],
  ['dsh-session/lib/types/index.d.ts', ["'session/event'(", 'list(): Session[];']],
  ['dsh-client-connection/lib/types/rpc.d.ts', ['export interface HostConnectionRpc', 'export interface ClientConnectionRpc']],
  ['dsh-client-connection/lib/types/rpc-host.d.ts', ['connection: HostConnectionHandle']],
  ['dsh-home-paths/lib/types/index.d.ts', ['export declare function dshHomePath']],
]

for (const [relative, needles] of checks) {
  const text = await readFile(path.join(packages, relative), 'utf8')
  for (const needle of needles) counted.ok(text.includes(needle), `${relative} missing: ${needle}`)
}

const client = await readFile(path.join(root, 'lib/client.js'), 'utf8')
counted.ok(client.includes("id: 'dsh-useful-taskball'"))
counted.ok(client.includes("name: 'shell.overlay'"))
counted.ok(client.includes("name: 'plugins.bundle.config'"))
// The Client reads Host state with a plain same-origin fetch to our exact
// `/api/taskball/*` routes, so it needs no `connection` service at all. The
// URL is built from the API_PATH / ENDPOINT_PREFIX constants, so assert on the
// pieces rather than one joined literal.
counted.ok(
  client.includes('API_PATH') && client.includes('ENDPOINT_PREFIX'),
  'Client 必须用 API_PATH + ENDPOINT_PREFIX 拼出精确路由地址',
)
counted.ok(client.includes("'taskball'") || client.includes('"taskball"'), 'Client 端点前缀必须是 taskball')
counted.equal(
  client.includes("'connection'"),
  false,
  'Client 不应再依赖 connection 服务（已改为直接 fetch 精确路由）',
)
counted.equal(manifest.name, 'dsh-useful-taskball')
counted.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')

const server = await readFile(path.join(root, 'lib/index.js'), 'utf8')
counted.ok(server.includes('session/event'), 'Server 端必须订阅 session/event')
// `session/event` is scope-filtered dispatch. Without `global: true` the
// listener only sees sessions entered through its own agent context, and this
// plugin has none — measured: 1 session observed while 14 were active across 6
// workspaces. Cross-session state is the entire point, so this must not regress.
counted.ok(
  /on\(\s*['"]session\/event['"]/.test(server),
  'Server 端必须订阅 session/event',
)
// Anchor on the closing brace of the listener body, which is what carries the
// options object; a bare `includes('global: true')` would pass even if the flag
// sat on some unrelated call.
counted.ok(
  /on\(\s*['"]session\/event['"][\s\S]{0,2000}?\}\s*,\s*\{\s*global:\s*true\s*\}\s*\)/.test(server),
  'Server 端订阅 session/event 必须带 { global: true }，否则收不到跨工作区的会话事件',
)
// Host routes MUST use `connection.fetch.register` (its own `fetchRoutes` table).
//
// Both RPC entries are unusable for a plugin:
// - `rpc.intercept('/api')` takes the SINGLE interceptor slot owned by
//   `dsh-api-gateway`. Whoever registers second throws; when a plugin wins, the
//   gateway's registration fails inside a child fiber with no log, and every
//   built-in Remote endpoint answers 404 — measured 2026-10-27, this took the
//   whole Web UI down.
// - `rpc.handle(channel)` registers via `owner.effect(() => owner.webServer…)`
//   on the CONNECTION service's context (`inject = ["credentials"]`), so the
//   effect throws and the route never exists.
counted.ok(
  /fetch\s*\.\s*register\(\s*\{/.test(server),
  'Host 路由必须用 connection.fetch.register（精确 Fetch 路由）',
)
// Paths are template literals joining API_PATH and ENDPOINT_PREFIX, so assert on
// the shape `…/${API_PATH}/${ENDPOINT_PREFIX}/state` rather than a joined literal.
counted.ok(
  /\$\{API_PATH\}\/\$\{ENDPOINT_PREFIX\}\/state/.test(server),
  '必须注册 state 精确路由（/api/taskball/state）',
)
counted.ok(
  /\$\{API_PATH\}\/\$\{ENDPOINT_PREFIX\}\/fold/.test(server),
  '必须注册 fold 精确路由（/api/taskball/fold）',
)
counted.equal(
  /\.intercept\(\s*['"]\/api['"]/.test(server),
  false,
  '绝不可占用 /api interceptor —— 那是 dsh-api-gateway 独占单槽，抢用会让全部内置 Remote 端点 404',
)
counted.equal(
  /\.handle\(\s*['"]/.test(server),
  false,
  '不得用 rpc.handle 注册通道（owner 是 connection 的 ctx，路由静默不注册）',
)
counted.equal(
  /inject\(\[[^\]]*'webServer'[^\]]*\]/.test(server),
  false,
  '不应把 webServer 写进注入列表 —— owner 是 connection 的 ctx，补自己的声明无效',
)

// The host's selector hooks are `useSyncExternalStoreWithSelector(subscribe,
// getSnapshot, undefined, selector, eq)`. Without `eq` the hook compares the
// selection with `Object.is`, so a selector that builds a new array counts as
// "changed" on every read. The hook then re-renders, the inline selector is a
// fresh function so the memo resets, the selection is rebuilt — forever. The
// loop ends when the slot's error boundary unmounts the overlay, so the ball
// simply vanishes with nothing in the console (measured 2026-10-27: switching
// workspace and sending a message killed the ball until the plugin was
// re-enabled).
//
// The first fix attempt cached the projection in a WeakMap. That cannot work:
// the memo's dependency list contains the selector itself, and an inline
// arrow is a new function every render, so the memo is rebuilt and the
// selector re-runs anyway. The equality function is the actual lever.
for (const [hook, comparer] of [
  ['useSessions', 'sameSessionList'],
  ['useSessionStatus', 'sameStatusMap'],
  ['useWorkspaces', 'sameWorkspaceView'],
]) {
  // The compiled bundle keeps the call on one line but the arrow body may wrap,
  // so match across newlines and stop at the comparer name itself.
  counted.ok(
    new RegExp(`props\\.${hook}\\([\\s\\S]{0,300}?${comparer}\\s*\\)`).test(client),
    `Client 端的 ${hook} 选择器必须带等值比较函数 ${comparer}，否则每次读取都被判定为快照变化并无限重渲染`,
  )
}
// D-033 (measured 2026-10-28): the ball announced "暂无任务状态" for 3.7–6.0s
// after every page load, because the first paint used empty fallbacks while the
// session-list pull was still in flight. `pending` must render as loading, never
// as empty. Asserted on source: the false-empty window only exists in a live
// browser, a static render test cannot see it.
{
  counted.ok(
    /props\.useSessions\([\s\S]{0,220}?state\.phase/.test(client),
    'D-033：overlay 必须读取会话列表的 arrival phase —— 未就绪不等于「没有任务」',
  )
  const ballSource = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(/readonly loading\?: boolean/.test(ballSource), 'D-033：球必须接收 loading')
  counted.ok(/t\('ball\.loading'\)/.test(ballSource), 'D-033：球未就绪时必须显示加载文案')
  const panelSource = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.ok(/t\('panel\.loading'\)/.test(panelSource), 'D-033：面板未就绪时必须显示加载文案')
  const hostSource = await readFile(path.join(root, 'src/client/host-state.ts'), 'utf8')
  counted.ok(/HOST_READY_GRACE_MS/.test(hostSource), 'D-033：Host 未就绪必须有超时兜底，不能永远加载')
}

// D-005: archiving retires a session from BOTH surfaces. The exclusion lives in
// `deriveView` so the ball and the panel read one list and cannot disagree.
// Asserted on the source, because a regression here is invisible in a unit test
// that only exercises one surface.
{
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  counted.ok(
    /if \(archived\.has\(session\.id\)\) continue/.test(model),
    '归档会话必须在 deriveView 里被排除（D-005），否则面板与扇形会各说各话',
  )
}
// The panel must NOT re-derive. Measured 2026-10-28: it called `deriveView`
// itself without the archive set, so an archived session vanished from the ball
// but stayed in the panel. Exactly one owner computes the view; both surfaces
// render that result.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.equal(
    /deriveView\(/.test(panel),
    false,
    'panel.ts 不得自己调用 deriveView —— 必须接收 overlay 算好的 view，否则会出现「球上没有、面板里还有」',
  )
  counted.ok(
    /readonly view: DerivedView/.test(panel),
    'panel.ts 必须从 props 接收 view',
  )
  // D-028: the ball and the panel's active list must use the SAME predicate.
  // Two hand-written filters ("!isFolded" in the panel, "sectorEntries" in the
  // ball) are how the two surfaces drifted apart in the first place — D-024's
  // blue exemption made the panel say "handled" while the ball still showed it.
  counted.ok(
    /occupiesSector\(entry\.color, folded, entry\.id\)/.test(panel),
    'panel.ts 的 active 列表必须复用 occupiesSector —— 与球同一个谓词，否则口径会再次分叉（D-028）',
  )
  counted.equal(
    /isFoldedInPanel/.test(panel),
    false,
    'panel.ts 不得再出现 isFoldedInPanel —— 该函数已删除，留着就是第二个口径（D-028）',
  )
}

// D-028: `occupiesSector` must not exempt any colour but gray.
{
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  const body = model.slice(model.indexOf('export function occupiesSector'))
  const fn = body.slice(0, body.indexOf('\n}'))
  counted.equal(
    /color === 'blue'/.test(fn),
    false,
    'occupiesSector 不得对蓝色开豁免 —— 球与面板必须口径一致（D-028）',
  )
}

// D-027: replay must CONSUME the Host's synthesized closers, never re-derive
// them. `interruptedTurnClosers` also supplies the missing `tool/result` events
// and the open `step/end`; a plugin-side "turn/start without turn/end" heuristic
// would fork from the Host's judgement the first time it changes. Asserted on
// source because the divergence is invisible while the Host's rule stays stable.
{
  const raw = await readFile(path.join(root, 'src/host/replay.ts'), 'utf8')
  // Strip comments first: this file NAMES `interruptedTurnClosers` in prose to
  // explain why it must not call it, and a naive substring gate would fail on
  // its own documentation.
  const replay = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  counted.equal(
    /interruptedTurnClosers/.test(replay),
    false,
    'replay.ts 不得自行调用/复刻 interruptedTurnClosers —— 必须消费 sessionQuery.readSession 已合成的 closer',
  )
  counted.equal(
    /kind:\s*'interrupted'/.test(replay),
    false,
    'replay.ts 不得自己合成 interrupted 标记，判据唯一 owner 是宿主',
  )
  // `sessionQuery` is optional: putting it in `inject` makes cordis throw when
  // absent and the whole loader entry goes inactive (AGENTS.md §6.7 / §13).
  const host = await readFile(path.join(root, 'src/host/index.ts'), 'utf8')
  counted.ok(
    /ctx\.get\('sessionQuery'\)/.test(host),
    'Host 必须用 ctx.get("sessionQuery") 取回放数据源（可选服务不得写进 inject）',
  )
  counted.equal(
    /inject\s*=\s*\[[^\]]*sessionQuery/.test(host),
    false,
    'sessionQuery 不得写进 inject —— 缺失时会让整个 loader entry 失活',
  )
  // The cursor is a seq. A synthetic closer reuses the last real event's time,
  // so a timestamp cursor silently skips closers that share a timestamp.
  counted.ok(
    /replayedThroughSeq/.test(replay),
    '回放游标必须是 seq（replayedThroughSeq），不能用时间戳 —— closer 会复用最后一条真实事件的时间',
  )
}

// D-034 (2026-10-28): the fold's semantic state is applied on click through a
// local override; neither the exit animation nor the 5s poll owns correctness.
// BUG1's patch (`awaitingFold` + an 8s safety net) made the panel's visibility
// depend on poll timing — the exact anti-pattern the spec names
// ("do not rely on animationend/transitionend for required state"). These gates
// retire that machinery and pin the new ownership.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.equal(
    /awaitingFold/.test(panel),
    false,
    'D-034：panel.ts 不得再有 awaitingFold —— 折叠语义不能等待 Host 轮询',
  )
  counted.equal(
    /AWAIT_CONFIRM_TIMEOUT_MS/.test(panel),
    false,
    'D-034：删掉补丁式安全网，写失败的自愈已上移到折叠覆盖层',
  )
  counted.ok(
    /visualFolded/.test(panel),
    'D-034：离场行必须用独立的绘制投影，不得改动语义集合',
  )
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/overriddenFolds\(/.test(index), 'D-034：overlay 必须应用本地折叠覆盖，球与面板同一份')
  counted.ok(/pruneFoldOverrides\(/.test(index), 'D-034：必须有覆盖回收（Host 确认 / 状态变化 / 超时）')
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  counted.ok(/FOLD_RECONCILE_MS/.test(model), 'D-034：折叠覆盖必须有安全窗口，写失败不能永久隐藏行')
}

// F-003 (D-035): an outside click closes the panel. Three layers must line up or
// the setting silently does nothing, and the close must go through the one
// `closePanel` — bypassing it drops the ball's closing spin (D-029). The
// listener also has to stay passive: `shell.overlay` is click-through, so
// swallowing the click would break the host UI underneath.
{
  const hostConfig = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  counted.ok(
    /closeOnOutsideClick:\s*z\.boolean\(\)\.default\(true\)\.volatile\(\)/.test(hostConfig),
    'F-003：Host schema 必须声明 closeOnOutsideClick 且默认 true',
  )
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  counted.ok(/field: 'closeOnOutsideClick'/.test(settings), 'F-003：设置页必须暴露该开关')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/settings\.closeOnOutsideClick !== false/.test(index), 'F-003：客户端必须读该设置')
  counted.ok(
    /addEventListener\('pointerdown', onPointerDown, \{ capture: true, passive: true \}\)/.test(index),
    'F-003：外点监听必须 passive —— 否则会吞掉宿主点击',
  )
  counted.ok(/closePanelRef\.current\(\)/.test(index), 'F-003：外点关闭必须走唯一 closePanel')
}

// 2026-11-03 (用户: 只保留色条和圆点，其他的不要了): the marker set was cut from
// six to two and the former `bar` was renamed `rect`. These checks replace the
// old D-029 / D-037 row-mode gates, which pinned modes that no longer exist.
//
// The point is not "two options exist" — it is that the three layers agree on the
// SAME two, and that none of the retired modes can come back. A mismatch here is
// silent: the settings page offers a value the renderer ignores, or the schema
// rejects a value the page writes.
{
  const hostConfig = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  const locale = await readFile(path.join(root, 'src/client/locale.ts'), 'utf8')

  // 三层的可渲染值集合必须一致：设置页暴露、面板类型、overlay 白名单。
  // Host schema 是例外 —— 它必须**额外**接受旧值（见下面那条），所以不参与
  // 「不得出现 retired」的断言，只参与「必须含 rect/dot」。
  for (const [label, src] of [
    ['Config schema', hostConfig],
    ['设置页选项', settings],
    ['面板类型', panel],
    ['overlay 白名单', index],
  ]) {
    counted.ok(src.includes("'rect'") || src.includes('z.const(\'rect\')') || src.includes('STATUS_MARKERS'), `${label} 必须含 rect`)
    counted.ok(src.includes("'dot'") || src.includes('z.const(\'dot\')') || src.includes('STATUS_MARKERS'), `${label} 必须含 dot`)
  }
  // 已删除的四种整行模式不得**复活为可渲染选项**（任何一个回来都会让「只保留
  // 两个」失效）。注意 schema 例外：它必须接受这些旧值才能迁移，否则旧 profile
  // 装载失败 —— 0.10.1 正是这么炸的（ValidationError: $.statusMarker ...）。
  for (const retired of ['row-solid', 'row-tint', 'row-box', 'row-tint-outline']) {
    counted.equal(settings.includes(`value: '${retired}'`), false, `设置页不得再暴露 ${retired}`)
    counted.equal(panel.includes(`'${retired}'`), false, `面板不得再渲染 ${retired}`)
    counted.equal(index.includes(`'${retired}'`), false, `overlay 白名单不得含 ${retired}`)
  }
  // Host schema 必须接受全部旧值 —— 这是 0.10.1 崩溃的直接原因，必须锁死。
  counted.ok(/LEGACY_STATUS_MARKERS/.test(hostConfig),
    'Config schema 必须声明 LEGACY_STATUS_MARKERS —— 否则旧 profile 的 statusMarker 会让整个插件条目装载失败')
  for (const legacy of ['bar', 'row-solid', 'row-tint', 'row-box', 'row-tint-outline']) {
    counted.ok(hostConfig.includes(`'${legacy}'`),
      `LEGACY_STATUS_MARKERS 必须含 ${legacy} —— 缺一个，选过它的用户就装不上`)
  }
  // 光声明还不够：schema 那一行必须**真的用上** ACCEPTED_STATUS_MARKERS。
  // 只锁声明会漏掉「常量还在，但 union 又退回 STATUS_MARKERS」这种变异 ——
  // 那正是 0.10.1 的原始 bug（负向验证第 ② 条实测没红后补的这一条）。
  const schemaLine = hostConfig.slice(hostConfig.indexOf('statusMarker: z.'), hostConfig.indexOf('statusMarker: z.') + 160)
  counted.ok(/ACCEPTED_STATUS_MARKERS/.test(schemaLine),
    'Config schema 的 statusMarker 必须消费 ACCEPTED_STATUS_MARKERS —— 只声明不引用等于没接受旧值')
  // ★ 迁移不能放在 schema 里。settings 层把 schema 序列化成 JSON 下发给客户端再
  // 重新校验，而 transform 的 callback 过 JSON 会变成字符串，客户端 rehydrate 后
  // 调用它抛 "callback is not a function" -> decode 返回 undefined -> form 永远
  // 停在 loading -> 设置完全存不进去（2026-11-03 实测，用户报「设置无法保存」）。
  // 所以 schema 必须是纯数据，迁移放客户端读取端。
  counted.equal(/z\.transform\(/.test(hostConfig), false,
    'Config schema 不得使用 z.transform —— 它的 callback 无法 JSON 往返，会让客户端 form 卡在 loading、设置全部存不进去')
  // 客户端必须承担迁移（这是唯一能跨端存活的位置）。
  counted.ok(/function statusMarkerOf\(/.test(index),
    '客户端必须提供 statusMarkerOf —— 旧值到可渲染值的映射只能放在这里')
  // 判据看函数体：非 rect/dot 的输入必须落到 rect（而不是原样透传或抛错）。
  const markerFn = index.slice(index.indexOf('function statusMarkerOf'), index.indexOf('function statusMarkerOf') + 220)
  counted.ok(/return 'rect'/.test(markerFn),
    'statusMarkerOf 必须把旧值映射成 rect —— 直接回落默认会静默丢掉用户的选择')
  // 面板只剩一个形状分支：色块与圆点共用同一 swatch，靠尺寸/圆角区分。
  counted.ok(/height: dot \? 8 : 14/.test(panel), '色块与圆点必须共用同一 swatch 渲染')
  counted.ok(/settings\.statusMarker\.rect/.test(locale), '文案必须为 rect 提供条目（改名后不得留 bar）')
  counted.equal(/settings\.statusMarker\.bar/.test(locale), false, '文案不得再留 settings.statusMarker.bar')
}

// D-039 (F-002): panel opacity + frosted glass. Two host tokens carry the
// material (`--dsw-menu-backdrop-filter`, and the panel background token).
// D-075 later made frosted + 30% the DEFAULT (the user asked for it), which
// deliberately overrides D-039's "default must not change" premise — the checks
// below now pin the NEW default across every fallback site, because a miss shows
// up as one frame of solid panel that unit tests cannot see.
{
  const hostConfig = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(
    /panelOpacity:\s*z\.number\(\)[\s\S]{0,120}\.default\(DEFAULT_PANEL_OPACITY\)\.volatile\(\)/.test(hostConfig),
    'F-002：Host schema 必须声明 panelOpacity 且走具名默认常量（D-039）',
  )
  counted.ok(
    /panelFrosted:\s*z\.boolean\(\)\.default\(true\)\.volatile\(\)/.test(hostConfig),
    'D-075：Host schema 必须声明 panelFrosted 且默认 true（磨砂 + 30% 是新默认外观）',
  )
  // D-075（用户 2026-11-02）：「默认值为磨砂加不透明度 30」。三条一起成立才算数：
  // 常量是 30、磨砂默认开、以及客户端两处兜底都指向同一个默认（否则首次渲染
  // 或配置缺失时会闪一帧实色面板）。
  counted.ok(/export const DEFAULT_PANEL_OPACITY = 30/.test(hostConfig),
    'D-075：不透明度默认常量必须是 30')
  counted.ok(/panelFrosted: createVolatile<boolean \| undefined>\(true\)/.test(hostConfig),
    'D-075：defaultConfig 里的磨砂默认值必须同步为 true')
  counted.ok(/typeof settings\.panelOpacity === 'number' \? settings\.panelOpacity : 30/.test(index),
    'D-075：overlay 的兜底必须是 30，否则首帧会渲染成实色')
  counted.ok(/const panelFrosted = settings\.panelFrosted !== false/.test(index),
    'D-075：overlay 的磨砂兜底必须是「非 false 即开」')
  counted.ok(/Number\.isFinite\(opacity\) \? opacity : PANEL_ALPHA_MIN/.test(panel),
    'D-075：panelAlpha 的畸形值兜底必须落到 30，不得回落 100')
  counted.ok(settings.includes("field: 'panelOpacity'"), 'F-002：设置页必须暴露不透明度（D-039）')
  // D-041（用户 2026-10-29）：不透明度用滑块，上下限必须与 Host schema 一致 ——
  // 控件的 30-100 若与 schema 漂移，用户能拖到一个被 Host 拒绝的值，保存才报错。
  const opacityBlock = settings.slice(settings.indexOf("field: 'panelOpacity'"), settings.indexOf("field: 'panelOpacity'") + 400)
  counted.ok(/kind:\s*'range'/.test(opacityBlock), 'D-041：不透明度必须是 range 滑块，不是数字框')
  counted.ok(/min:\s*30/.test(opacityBlock), 'D-041：滑块下限必须是 30（与 PANEL_OPACITY_MIN 一致）')
  counted.ok(/max:\s*100/.test(opacityBlock), 'D-041：滑块上限必须是 100（与 PANEL_OPACITY_MAX 一致）')
  counted.ok(
    /type: 'range'/.test(settings) && /data-taskball-range-value/.test(settings),
    'D-041：滑块必须渲染 type=range 并带可见数值',
  )
  counted.ok(settings.includes("field: 'panelFrosted'"), 'F-002：设置页必须暴露磨砂开关（D-039）')
  counted.ok(/settings\.panelOpacity/.test(index), 'F-002：客户端必须读 panelOpacity（D-039）')
  counted.ok(/settings\.panelFrosted/.test(index), 'F-002：客户端必须读 panelFrosted（D-039）')
  // The material moved to `material.ts` when F-009's popup needed the same one;
  // panel.ts must READ it there rather than keep a second copy.
  const material = await readFile(path.join(root, 'src/client/material.ts'), 'utf8')
  counted.ok(
    material.includes('--dsw-menu-backdrop-filter'),
    'F-002：磨砂必须用宿主菜单材质 token，不得自造 blur（D-039）',
  )
  counted.ok(/from '\.\/material\.js'/.test(panel), 'F-002：面板磨砂必须取自 material.ts（单一 owner）')
  counted.ok(
    /alpha >= PANEL_ALPHA_MAX[\s\S]{0,200}var\(--dsw-alias-bg-layer-2/.test(panel),
    'F-002：不透明度 100 仍必须走原 token（D-039 的实心外观仍可达）',
  )
  counted.ok(/FROSTED_ALPHA_CAP/.test(panel), 'F-002：磨砂必须有 alpha 上限，否则模糊看不出来（D-039）')
  // The panel's own background must come from a host token: a hard-coded colour
  // would break the dark theme and the skin/theme work.
  counted.equal(
    /background:\s*'#[0-9a-fA-F]{3,6}'[\s\S]{0,200}data-taskball-panel/.test(panel),
    false,
    'F-002：面板底色不得硬编码（D-039）',
  )
}

// D-040 (F-012): the row's slot collapses 1fr → 0fr so the panel's height moves
// with the row instead of jumping when the row unmounts. The implementation must
// stay measurement-free: measuring the row and animating `height` is exactly the
// pattern F10 proved re-triggers itself in this host.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  counted.ok(panel.includes("'data-taskball-slot'"), 'F-012：行必须包在可收缩的槽位里（D-040）')
  counted.ok(
    /gridTemplateRows:\s*isLeaving \? '0fr' : '1fr'/.test(panel),
    'F-012：离场时轨道必须落到 0fr（D-040）',
  )
  counted.ok(/overflow: 'hidden'/.test(panel), 'F-012：收缩必须裁剪（D-040）')
  counted.equal(
    /getBoundingClientRect\(\)[\s\S]{0,120}setLeaving/.test(panel),
    false,
    'F-012：不得靠测量行高补间 —— F10 已证明会自我触发（D-040）',
  )
  counted.ok(
    /\[data-taskball-slot\][\s\S]{0,140}transition: grid-template-rows 220ms/.test(style),
    'F-012：收缩时长必须与 slide-out 的 220ms 对齐（D-040）',
  )
  counted.ok(
    /\[data-taskball-slot\]\[data-anim="slide-down"\][\s\S]{0,160}transition-duration: 280ms/.test(style),
    'F-012：slide-down 必须跟随 280ms（D-040）',
  )
  counted.ok(
    /prefers-reduced-motion[\s\S]{0,240}\[data-taskball-slot\]/.test(style),
    'F-012：reduced-motion 下不得补间（D-040）',
  )
}

// D-037 (F-005) was RETIRED on 2026-11-03 together with the whole-row modes:
// `row-tint-outline` no longer exists, so its 0.5px theme-outline rules are gone
// from style.ts. What survives is the principle worth keeping — a THEME ink must
// never enter palette.ts, which holds status hues only (D-030).
{
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  const palette = await readFile(path.join(root, 'src/client/palette.ts'), 'utf8')
  // Strip comment lines first: the sheet documents WHY the rules were removed, and
  // that prose mentions the variable name (§13 cause ② — the gate matching its own
  // documentation).
  const styleCode = style.split('\n').filter((line) => !line.trim().startsWith('/*') && !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n')
  counted.equal(styleCode.includes('--taskball-row-outline'), false,
    '已删除的整行描边模式不得在 style.ts 里留下死规则（2026-11-03）')
  counted.equal(/#fff|#000/.test(palette), false, '描边色不得进入 palette.ts —— 那里只放状态色（D-030）')
}

// F-006: rows live in ONE column wrapper whose only spacing is a 0.5px row gap;
// the group label stays outside it. A second spacing mechanism would stack with
// the gap, so the absence of per-row margins is asserted as well.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.ok(/const ROW_GAP_PX = 0\.5/.test(panel), 'F-006：行间间隙必须是唯一的 0.5px 常量')
  counted.ok(panel.includes("'data-taskball-rows'"), 'F-006：行必须包在可查询的列容器里')
  counted.ok(/rowGap: ROW_GAP_PX/.test(panel), 'F-006：间隙必须来自该常量')
  counted.equal(/marginTop/.test(panel), false, 'F-006：不得再用 marginTop 叠加第二套行距')
}

// D-038 (F-004): confirming a failure slides the whole row left and shows two
// blocks in the space it leaves (cancel / red confirm). The old box appended
// UNDER the row must be gone, the confirm text must state the action in words
// (a red fill is not an accessible name), Esc must cancel, and the motion must
// not be load-bearing for the fold itself.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  // The two confirm surfaces moved to their own module (refactor 2026-11-01).
  // `panel.ts` still owns what makes them "in place" — the row's
  // `data-confirming`, the Esc listener and the focus hand-back — so both files
  // are read rather than relaxing either assertion.
  const confirmUi = await readFile(path.join(root, 'src/client/panel-confirm.ts'), 'utf8')
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(confirmUi.includes('function RedConfirmBar'), '确认条必须是「原位两块」（D-038）')
  counted.equal(/function ConfirmRed\b/.test(panel + confirmUi), false, '行下方的旧告警框必须删除（D-038）')
  counted.ok(panel.includes("'data-confirming'"), '行必须带 data-confirming 才能左滑让位（D-038）')
  counted.ok(
    /\[data-taskball-row\]\[data-confirming="true"\]/.test(style),
    '左滑必须是 CSS 的 data-confirming 状态（D-038）',
  )
  const bar = confirmUi.slice(confirmUi.indexOf('function RedConfirmBar'))
  counted.equal(
    (bar.match(/type: 'button'/g) ?? []).length,
    2,
    '确认条必须恰好是「取消 / 确认」两块（D-038）',
  )
  counted.equal(/confirmRed\.open/.test(index), false, '第三个「查看会话」按钮已按用户裁定删除（D-038）')
  // The string itself lives in the locale tables now (refactor 2026-11-01), so
  // the wording is asserted where it is DEFINED rather than where it is used.
  const locale = await readFile(path.join(root, 'src/client/locale.ts'), 'utf8')
  counted.ok(locale.includes('确认已处理'), '确认块的文字必须写明后果，不能只靠红底（D-038）')
  counted.ok(panel.includes('addEventListener(\'keydown\''), 'Esc 必须能取消确认（D-038）')
  counted.ok(panel.includes('focusRowCheck'), '取消/确认后必须把焦点交还（D-038）')
  const confirmHandler = panel.slice(panel.indexOf('onConfirm: () => {'), panel.indexOf('onConfirm: () => {') + 600)
  counted.equal(/animateOut/.test(confirmHandler), false, '确认后的折叠不得依赖离场动画（D-034 / D-038）')
  counted.ok(
    /prefers-reduced-motion[\s\S]*\[data-taskball-row\][\s\S]*transition: none/.test(style),
    'prefers-reduced-motion 下左滑必须直接落终态（D-038）',
  )
}

// F8: the panel header no longer renders the "任务状态" title text. The dialog
// keeps it as `aria-label`; losing that too would drop the accessible name, so
// both halves are asserted.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const header = panel.slice(panel.indexOf("'data-taskball-panel': 'true'"))
  counted.equal(
    /h\('strong'/.test(header),
    false,
    '面板头部不得再渲染标题文字（F8）',
  )
  counted.ok(
    /'aria-label': t\('panel\.title'\)/.test(panel),
    'dialog 必须保留 aria-label 作为无障碍名称（F8）',
  )
}

// F10: one continuous outer outline for the bubble. A `border` on the wrapper
// would draw across the notch where the tail meets the body, which is exactly
// the seam the design forbids.
{
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(ball.includes('drop-shadow'), '气泡外轮廓必须用 drop-shadow 描并集（F10）')
  counted.equal(
    /border:\s*'1px solid rgba\(15, 23, 42, 0\.16\)'/.test(ball),
    false,
    '气泡 wrapper 不得再画 border，否则缺口处会出现一条线（F10）',
  )
  counted.ok(
    /translateY\(-50%\) rotate\(45deg\)/.test(ball),
    '尖角必须垂直居中（F10）',
  )
}

// F-015 (user 2026-11-01): 「可以让那个三角形再小一些」 + 轮廓太淡。
// 两个数字都必须绑到具名常量上：写成字面量的话下次改动会漏掉其中一处
// （TAIL 同时出现在尺寸、偏移、以及 TAIL*2 三处）。
{
  const ballSrc = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(/export const TAIL = 5\r?\n/.test(ballSrc),
    'F-015：尖角必须缩到 5px（原 7px）且是具名导出，便于测试与门禁断言')
  counted.ok(/export const BUBBLE_OUTLINE_PX = 0\.75\r?\n/.test(ballSrc),
    'F-015：描边必须加粗到 0.75px（0.5px 在 1x DPR 下被抗锯齿吃掉）')
  // 光有常量不算 —— 必须被真的用上。尖角的三处引用都不得是字面量。
  const tailBody = ballSrc.slice(ballSrc.indexOf('export function TaskballBubble('))
  counted.ok(tailBody.length > 2000,
    'F-015：TaskballBubble 切片必须非空（空切片会让下面的断言空转通过）')
  counted.ok(/height: TAIL \* 2/.test(tailBody) && /width: TAIL \* 2/.test(tailBody),
    'F-015：尖角尺寸必须是 TAIL * 2，不得写字面量')
  counted.ok(/right: -TAIL|left: -TAIL/.test(tailBody),
    'F-015：尖角偏移必须跟着 TAIL，不得写字面量')
  counted.equal(/height: 14\b/.test(tailBody), false,
    'F-015：不得残留旧的 14px 尖角尺寸')
  counted.ok(/drop-shadow\(0 0 \$\{BUBBLE_OUTLINE_PX\}px/.test(tailBody),
    'F-015：描边那一层必须读 BUBBLE_OUTLINE_PX，不得是字面量 0.5px')
  counted.equal(/drop-shadow\(0 0 0\.5px/.test(tailBody), false,
    'F-015：不得残留旧的 0.5px 描边')
  counted.ok(/drop-shadow\(0 6px 20px/.test(tailBody),
    'F-015：柔光投影不得被顺手删掉')
}

// D-030: one owner for the status palette. `ball-visual.ts` used to keep its own
// copy of the same hex literals as `panel.ts`, so a colour change reached only
// one surface — and the ball is the surface with no text fallback. A literal
// status hex outside `palette.ts` means a second copy has grown back.
{
  const clientFiles = ['panel.ts', 'ball.ts', 'ball-visual.ts', 'index.ts', 'settings.ts', 'style.ts', 'model.ts', 'host-state.ts']
  const statusHexes = ['#f16662', '#ffac50', '#52a7ff', '#47d489', '#c3ccd9']
  const offenders = []
  for (const file of clientFiles) {
    const text = await readFile(path.join(root, 'src/client', file), 'utf8')
    for (const hex of statusHexes) {
      if (text.includes(hex)) offenders.push(`${file}:${hex}`)
    }
  }
  counted.deepEqual(
    offenders,
    [],
    `状态色字面量只能出现在 palette.ts（D-030）；发现重复定义：${offenders.join(', ')}`,
  )
  const palette = await readFile(path.join(root, 'src/client/palette.ts'), 'utf8')
  for (const hex of statusHexes) {
    counted.ok(palette.includes(hex), `palette.ts 必须定义 ${hex}`)
  }
  // Both paint surfaces must read the shared module, not each other's copies.
  const ballVisual = await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8')
  counted.ok(ballVisual.includes("from './palette.js'"), 'ball-visual.ts 的扇形颜色必须来自 palette.ts（D-030）')
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(ball.includes("from './palette.js'"), 'ball.ts 的颜色必须来自 palette.ts（D-030）')
}

// D-031: the colour-blind palette swaps two fills, and THREE surfaces paint
// status colours — the panel rows, the ball's sectors, the transition bubble.
// Missing any one of them leaves that surface on the old palette, and the ball is
// the surface with no text fallback, so the gap would hit exactly the users the
// feature exists for. Asserted on source because each surface renders separately.
{
  const palette = await readFile(path.join(root, 'src/client/palette.ts'), 'utf8')
  counted.ok(/export const COLOR_HEX_CB/.test(palette), 'palette.ts 必须定义色盲配色（D-031）')
  counted.ok(
    /export function paletteFor/.test(palette),
    'palette.ts 必须提供 paletteFor(开关) 选择函数（D-031）',
  )
  // The two replacement fills must actually differ from the defaults, otherwise
  // the toggle silently does nothing.
  const cbBlock = palette.slice(palette.indexOf('COLOR_HEX_CB'), palette.indexOf('COLOR_INK_CB'))
  counted.equal(/#f16662/.test(cbBlock), false, '色盲配色不得复用默认红')
  counted.equal(/#47d489/.test(cbBlock), false, '色盲配色不得复用默认绿')

  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/paletteFor\(settings\.colorBlindMode/.test(index), 'overlay 必须按设置选调色板（D-031）')
  for (const surface of ['TaskballPanel', 'TaskballBall', 'TaskballBubble']) {
    const start = index.indexOf(`h(${surface}, {`)
    counted.ok(start >= 0, `找不到 ${surface} 的调用点`)
    // Brace-match the props object rather than a fixed window: a window gets
    // truncated by the first nested `})`.
    let depth = 0
    let block = ''
    for (let i = start; i < index.length; i += 1) {
      if (index[i] === '{') depth += 1
      else if (index[i] === '}') {
        depth -= 1
        if (depth === 0) { block = index.slice(start, i + 1); break }
      }
    }
    counted.ok(block.includes('palette'), `${surface} 必须收到 palette —— 少一处就会与其余表面不一致（D-031）`)
  }

  const hostConfig = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  counted.ok(/colorBlindMode:\s*z\.boolean\(\)\.default\(false\)/.test(hostConfig), 'Host schema 必须有 colorBlindMode 且默认 false')
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  counted.ok(settings.includes("field: 'colorBlindMode'"), '设置页必须暴露色盲模式开关')
}

// F-009: right-click quick settings. It is a THIRD overlay layer, so the binding
// that matters most is the single outside-click owner: a second listener would
// be a second answer to "is this click outside", which is exactly the
// double-owner shape AGENTS.md §2.11 forbids. Also asserted: the menu material
// is borrowed from ONE module (so the panel's frosted mode and this popup can
// never drift), the popup edits the SHARED config form (B-003: borrowed, never
// disposed), and the mouse-only gesture has a keyboard equivalent.
{
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const quick = await readFile(path.join(root, 'src/client/quick.ts'), 'utf8')
  const material = await readFile(path.join(root, 'src/client/material.ts'), 'utf8')
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  counted.ok(/onContextMenu/.test(ball), 'F-009：球必须挂 onContextMenu')
  counted.ok(/event\.shiftKey && event\.key === 'F10'/.test(ball), 'F-009：必须有键盘等效入口（Shift+F10）')
  const pointerDown = ball.slice(ball.indexOf('const onPointerDown'), ball.indexOf('const onKeyDown'))
  counted.ok(/event\.button !== 0/.test(pointerDown), 'F-009：主键路径必须保持只认 button 0')
  counted.equal(/onQuick/.test(pointerDown), false, 'F-009：右键语义不得进入拖拽/点击路径')
  counted.ok(panel.includes("'data-taskball-quick-trigger'"), 'F-009：面板必须提供快捷设置入口')
  counted.ok(quick.includes("'data-taskball-quick'"), 'F-009：快捷面板必须是独立浮层')
  counted.ok(
    /addEventListener\('pointerdown', onPointerDown, \{ capture: true, passive: true \}\)/.test(index),
    'F-009：外点监听必须 capture + passive（不得吞掉宿主点击）',
  )
  counted.equal(
    (index.match(/addEventListener\('pointerdown'/g) ?? []).length,
    1,
    'F-009：外点监听必须只有一个 owner（铁律 11）',
  )
  const inside = index.slice(index.indexOf('const INSIDE_SELECTOR'), index.indexOf('const INSIDE_SELECTOR') + 400)
  for (const layer of ['data-taskball-panel', 'data-taskball-ball', 'data-taskball-bubble', 'data-taskball-quick']) {
    counted.ok(inside.includes(layer), `F-009：外点选择器必须包含 ${layer}`)
  }
  counted.ok(/MENU_BACKDROP_FILTER/.test(material), 'F-009：材质必须定义在一个共用模块')
  for (const file of [panel, quick]) {
    counted.ok(/from '\.\/material\.js'/.test(file), 'F-009：磨砂材质必须来自 material.ts，不得各写一份')
  }
  counted.equal(
    /blur\(40px\)/.test(quick),
    false,
    'F-009：快捷面板不得自造 blur —— 必须走宿主菜单材质 token',
  )
  counted.ok(/data-taskball-quick/.test(style), 'F-009：快捷面板必须有自己的入场动画规则')
  counted.ok(
    /prefers-reduced-motion[\s\S]{0,600}\[data-taskball-quick\]/.test(style),
    'F-009：reduced-motion 下快捷面板不得播动画',
  )
  // The popup writes through the ONE writer (D-046) rather than calling the
  // shared form itself: a second call site would be a second owner of the write
  // queue, and that is exactly how a burst of edits produced refused
  // (stale-revision) writes that silently dropped everything but the first value.
  counted.ok(/writer\.set\(/.test(index), 'F-009：快捷面板改值必须走唯一的 settings writer')
  counted.equal(/\.mutate\(/.test(index), false, 'F-009：客户端不得在 writer 之外调用 mutate')

  // F-020 (user 2026-11-01): the popup grew from 5 settings to 7 — `showFoldedSection`
  // and the font size joined. What must stay true is that every row it offers is a
  // FIELD THAT ALREADY EXISTS: the popup is not allowed to invent settings of its
  // own, because a second definition would drift from the one Settings writes.
  // Two spellings: direct `onSet('field')` calls and `switchRow('field')` rows.
  const popupFields = [
    ...[...quick.matchAll(/onSet\('([a-zA-Z]+)'/g)].map((match) => match[1]),
    ...[...quick.matchAll(/switchRow\('([a-zA-Z]+)'/g)].map((match) => match[1]),
  ]
  const declaredFields = [...(await readFile(path.join(root, 'src/client/settings.ts'), 'utf8'))
    .matchAll(/field: '([a-zA-Z]+)'/g)].map((match) => match[1])
  // D-073 (user 2026-11-02) reshaped the row set: status marker and colour-blind
  // mode left, ball size arrived. The COUNT is deliberately not asserted — what
  // matters is that every row is an existing field (below) and that the specific
  // rows the user asked for are present/absent.
  counted.ok(popupFields.length >= 6, `D-073：快捷面板至少 6 项，实得 ${popupFields.length}`)
  for (const field of new Set(popupFields)) {
    counted.ok(declaredFields.includes(field),
      `F-020：快捷面板写的 '${field}' 必须是 FIELDS 里已有的字段 —— 不得自造设置项`)
  }
  counted.ok(popupFields.includes('showFoldedSection'), 'F-020：必须加入「显示已处理区」')
  counted.ok(popupFields.includes('fontSizeMode') && popupFields.includes('fontSizePx'),
    'F-020：必须加入面板字号（模式 + 自定义 px 两个字段，缺一个都调不了）')
  // D-073 reverse assertions: the two rows the user removed must not come back,
  // and ball size must be present. "Removed a row" and "added a row" are two
  // independent facts; asserting only the addition would let the removals revert.
  counted.ok(popupFields.includes('ballSize'),
    'D-073：球大小必须放进快捷面板（用户 2026-11-02）')
  counted.equal(popupFields.includes('statusMarker'), false,
    'D-073：状态表示不得再出现在快捷面板（用户 2026-11-02：「状态表示也不要了」）')
  counted.equal(popupFields.includes('colorBlindMode'), false,
    'D-073：色盲配色不得再出现在快捷面板（用户 2026-11-02：「色盲不放进快捷面板」）')
  // The two exits share one row now, and the collapse hint is gone.
  counted.ok(/data-taskball-quick-actions/.test(quick),
    'D-073：打开全部设置与收起必须放在同一行')
  counted.equal(/quick\.collapseHint/.test(quick), false,
    'D-073：收起按钮下方的小字注解必须删除（用户 2026-11-02）')
  // The fit test must track the row count, or the popup flips above the ball on
  // windows where it would have fit (looks like the menu jumping for no reason).
  counted.ok(/const QUICK_ESTIMATED_HEIGHT = 384/.test(quick),
    'F-020：估算高度必须同步跟随行数')
  counted.ok(/const QUICK_MAX_HEIGHT = 420/.test(quick),
    'F-020：上限也要跟着抬，否则行数多时会被裁掉')
  counted.ok(/quick\.openAll/.test(quick), 'F-009：必须给「打开全部设置」出口')
  // Where the configuration page ACTUALLY lives, measured on the real page
  // 2026-10-29: `plugins.bundle.config` is a child of the `main` slot's
  // `plugins` key (the plugin manager panel), NOT of the Settings dialog. The
  // first route navigated Settings and looked like a success while landing on a
  // page with none of this plugin's fields. Both halves of the real route are
  // optional services read through `ctx.get`, hence the absence assertions.
  const openSettings = await readFile(path.join(root, 'src/client/open-settings.ts'), 'utf8')
  counted.ok(/MAIN_SLOT = 'main'/.test(openSettings), 'F-009：必须从 main 槽读 plugin-manager 面板')
  counted.ok(/PANEL_ID|PLUGINS_PANEL_ID = 'plugins'/.test(openSettings), 'F-009：必须选中 plugins 中央面板')
  counted.ok(/kind: 'package'/.test(openSettings), 'F-009：必须直接打开包页，而不是插件列表')
  counted.equal(
    /sidebar\.settings|settings\.open/.test(openSettings),
    false,
    'F-009：不得导航设置对话框 —— 那里面没有本插件的配置页',
  )
  counted.ok(
    /ctx\.get\('layout'\)/.test(index),
    'F-009：layout 是可选服务，必须用 ctx.get 读取（缺少时插件仍要激活）',
  )
  // The popup carries padding and a border, so `QUICK_WIDTH` is only true under
  // `border-box`. Measured 2026-10-29: content-box rendered 273.3px against a
  // 248px placement constant, overflowing the viewport by 25px near the right
  // edge while the flip check still believed it fit. Source-level on purpose:
  // the unit test can only assert the string appears in the source it reads, so
  // it would keep passing if the property moved to a component that is not
  // rendered by that test.
  counted.ok(
    /boxSizing: 'border-box'/.test(quick),
    'F-009：快捷面板必须 border-box —— 否则实测宽度（273.3px）大于定位常量（248px）并从视口溢出',
  )
  counted.ok(/padding: 12/.test(quick) && /border: '1px solid/.test(quick),
    'F-009：border-box 的前提是面板确有 padding/border；两者变化时这条断言要一起复核')
}

// F-011: the settings page is split into tabs, but FIELDS stays the ONE owner
// of "what a setting is". The save path must walk FIELDS (not the visible tab),
// every field must carry a group, and the tabs must be real tab semantics rather
// than decorated divs. A field whose group is missing would vanish from every
// tab while save() still writes it — invisible but live, the worst shape.
{
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  counted.ok(
    /export const FIELD_GROUPS = \['appearance', 'motion', 'notify'\] as const/.test(settings),
    'F-011：必须正好三组：外观 / 动效 / 通知',
  )
  const declared = [...settings.matchAll(/field: '([a-zA-Z]+)'/g)].map((match) => match[1])
  // 13 → 14 when F-018 added `ballSize`, 14 → 15 when F-019 added `snapDistance`.
  // rather than derived so that adding a field is a deliberate, reviewed change to
  // this gate instead of something that slips in with the schema.
  counted.equal(declared.length, 15, `F-011：FIELDS 必须仍登记 15 个字段，实得 ${declared.length}`)
  counted.ok(declared.includes('ballSize'), 'F-018：ballSize 必须在 FIELDS 里，否则设置页没有它的控件')
  counted.ok(declared.includes('snapDistance'), 'F-019：snapDistance 必须在 FIELDS 里，否则设置页没有它的控件')
  for (const field of declared) {
    // Slice to the NEXT field, not a fixed window: a 400-character window spills
    // into the next entry and reads ITS group, so a field with no group at all
    // still passes. Proven by deleting one group and watching the gate stay green
    // (2026-10-29) — the window was the defect, not the missing gate.
    const start = settings.indexOf(`field: '${field}'`)
    const nextStart = settings.indexOf("field: '", start + 1)
    const block = settings.slice(start, nextStart > start ? nextStart : start + 600)
    counted.ok(
      /group: '(appearance|motion|notify)'/.test(block),
      `F-011：${field} 必须归入某一组，否则它会从所有标签消失却仍被保存`,
    )
    // The same window must not contain a second field: that would mean the slice
    // and the ledger disagree about field boundaries.
    counted.equal(
      (block.match(/field: '/g) ?? []).length,
      1,
      `F-011：${field} 的切片边界必须只含一个字段`,
    )
  }
  // D-046 replaced the draft-then-save step with real-time writes: every control
  // hands its value to the writer, and there is no `save()` left to keep in sync
  // with the visible tab. A save() reappearing here would mean two write paths.
  const renderField = settings.slice(settings.indexOf('const renderField'), settings.indexOf('// The failure is reported OUTSIDE'))
  counted.ok(/writer\.set\(/.test(renderField), 'D-046：字段控件必须直接写 writer（实时保存）')
  counted.equal(/const save = async/.test(settings), false, 'D-046：设置页不得再保留草稿-保存两段式')
  counted.ok(/role: 'tablist'/.test(settings), 'F-011：标签必须用 tablist 角色')
  counted.ok(/role: 'tabpanel'/.test(settings), 'F-011：必须有 tabpanel 角色')
  counted.ok(/ArrowRight/.test(settings) && /ArrowLeft/.test(settings), 'F-011：标签必须支持方向键切换')
  counted.ok(/tabIndex: selected \? 0 : -1/.test(settings), 'F-011：必须用 roving tabindex')
  // D-045 taught that `--dsw-alias-brand-primary` is a dark ink in the light theme
  // and NEAR-WHITE in the dark one, so hard-coded white text under it measured
  // 1.0:1. The save button that carried that bug is gone (D-046), but the lesson
  // is an invariant for any future primary surface, and the failure text itself
  // must stay on the host's danger token.
  counted.equal(
    /color: 'white'/.test(settings),
    false,
    'F-011：不得硬编码白色文字 —— 深色主题下会与近白底色重合（D-045）',
  )
  counted.ok(
    /--dsw-alias-label-danger/.test(settings),
    'D-046：失败提示必须用宿主 danger token，不得硬编码颜色',
  )
}

// D-046: real-time settings writes. Measured on the real page 2026-10-29: ONE
// Host write answers in 1095 ms (next one 2734 ms), because the settings service
// applies a volatile field by writing the profile patch and reconciling the
// Loader — i.e. restarting this plugin's entry — and the RPC waits for that.
// Three properties fall out, and each has a failure mode seen for real:
//  - the control must move BEFORE the answer (otherwise nothing visibly happens
//    for seconds, which is the reported bug),
//  - a burst must become ONE write (a slider drag queued a reload per event),
//  - the write must NOT carry `expectedRevision` (a revision read before
//    queueing is stale by the time the write runs; the Host answers
//    `settings/conflict` and drops the value).
{
  const writer = await readFile(path.join(root, 'src/client/settings-writer.ts'), 'utf8')
  counted.ok(/export const WRITE_DELAY_MS/.test(writer), 'D-046：写合并窗口必须是具名常量，不是散落的魔法数')
  counted.ok(/form\.mutate\(ops\)/.test(writer), 'D-046：写入必须不带 expectedRevision（Host 无条件写入）')
  counted.equal(/form\.mutate\([^)]*,/.test(writer), false, 'D-046：不得给 mutate 传第二个参数')
  counted.ok(/pending/.test(writer) && /overrides/.test(writer), 'D-046：必须有本地待写值叠加层（先显示、后核对）')
  // One owner for the write queue: any other client module calling mutate would
  // reintroduce the stale-revision race in a place the writer cannot see.
  for (const file of ['index.ts', 'settings.ts', 'quick.ts', 'panel.ts', 'ball.ts', 'host-state.ts']) {
    const text = await readFile(path.join(root, 'src/client', file), 'utf8')
    counted.equal(/\.mutate\(/.test(text), false, `D-046：${file} 不得直接调用 mutate —— 写队列只有 settings-writer 一个 owner`)
  }
  counted.ok(/settingsWriterFor/.test(writer), 'D-046：同一个 form 必须复用同一个 writer（两个设置面共用一条队列）')
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/useSettings\(props\.configForm\)/.test(index), 'D-046：overlay 必须从 writer 读设置，才能立即反映')
  counted.ok(/settingsSession\.writer\.set/.test(index), 'D-046：快捷面板必须走 writer 写入')
  // A settings page with no Save button must say what replaced it.
  const settings = await readFile(path.join(root, 'src/client/settings.ts'), 'utf8')
  counted.ok(/settings\.autoSave/.test(settings), 'D-046：实时保存必须在页面上说明（没有保存按钮，就没有别的信号）')
}

// F-007: the ball sticks to the layout it belongs to. Two failure modes are
// invisible in a green test run: reading the layout through a hash class (breaks
// on every host build) and a snapped ball that does not FOLLOW its line (collapse
// the sidebar and the ball hangs in mid-air, still "attached" to nothing).
{
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(
    /data-dsh-center-col/.test(ball),
    'F-007：吸附线必须从宿主中心列读（data 属性），不得硬编码侧栏宽度',
  )
  counted.equal(
    /pI_x6G/.test(ball),
    false,
    'F-007：不得把宿主的哈希类名当选择器 —— 每次宿主构建都会变',
  )
  counted.ok(/export const SNAP_DISTANCE/.test(ball), 'F-007：吸附阈值必须是具名常量，不是散落的魔法数')
  counted.ok(
    /export const LINE_GAP/.test(ball),
    'F-007：贴着分界线时必须留间隙，否则球会盖住宿主 8px 的 resize handle',
  )
  counted.ok(
    /MutationObserver/.test(ball),
    'F-007：侧栏折叠不改变窗口尺寸 —— 必须观察 AppFrame 的 style/data 变化，不能只监听 resize',
  )
  counted.ok(
    /subtree: true/.test(ball),
    'F-007：必须观察 document.body 子树 —— 挂载时 AppFrame 的列还没渲染（实测查询返回 null），抓节点会静默失联',
  )
  counted.ok(
    /Observer === undefined/.test(ball),
    'F-007：宿主没有 MutationObserver 时必须降级成只贴四边，不能抛错',
  )
  counted.equal(
    /requestAnimationFrame/.test(ball),
    false,
    'F-007：吸附只在拖拽结束与布局变化时算一次 —— 不得引入常驻逐帧循环（会让拖拽发粘）',
  )
  counted.ok(
    /attachX/.test(ball) && /attachY/.test(ball),
    'F-007：吸附意图必须随位置一起落 localStorage，刷新后仍贴着线',
  )
  for (const edge of ["kind: 'left'", "kind: 'right'", "kind: 'top'", "kind: 'bottom'"]) {
    counted.ok(ball.includes(edge), `F-007：视口四边都必须是吸附目标（缺 ${edge}）`)
  }
}

// B-009 (reported 2026-10-30): a FOCUSED session turning green flashed gray for up
// to one poll interval, and its completion bubble never fired. The cause was not
// the bubble: `deriveView` combined the event-driven status with the 5s-polled
// Host record, so the in-between window read gray — splitting the edge into
// blue→gray→green, and `transitionsOf` only announces edges leaving blue.
// Source-level on purpose: the defect is a branch ORDER inside one function, and a
// future refactor could restore the old order without touching the bubble code.
{
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  counted.ok(
    /export function turnInFlight/.test(model),
    'B-009：必须有 turnInFlight —— 用「Host 已开始但未记录结束」补上轮询延迟窗口',
  )
  // B-009 第一版只凭 Host 记录判在跑，结果 7 条陈旧记录（1.9–6.7 天前，结束事件被插件重
  // 启吞掉）全被画成蓝 —— 用户报「好多蓝色，点开都是已完成的」。所以判据必须**同时**要
  // 两个见证：Host 无结束记录 + 客户端在窗口内见过它 running。删掉任何一个都变回某一边
  // 的坏行为，两条都得锁。
  const inFlight = model.slice(model.indexOf('export function turnInFlight'), model.indexOf('export function noteRunning'))
  counted.ok(
    /witness/.test(inFlight),
    'B-009：turnInFlight 必须接受「客户端见证」参数 —— 只凭 Host 记录会把数天前的陈旧记录判成在跑',
  )
  counted.ok(
    /now - witness <= windowMs/.test(inFlight),
    'B-009：见证必须带时间窗 —— 否则一次「见过在跑」永久有效',
  )
  counted.ok(
    /lastEndAt >= startedAt\) return false/.test(inFlight),
    'B-009：Host 已记录结束（晚于开始）时必须排除',
  )
  counted.ok(
    /export function noteRunning/.test(model) && /export function pruneWitnesses/.test(model),
    'B-009：必须记录并回收「见过在跑」的见证，否则 MAP 会无限增长或见证永不过期',
  )
  const derive = model.slice(model.indexOf('const live = classifyStatus'), model.indexOf('if (isGreenExpired'))
  // Assert the DECISION, not the formatting: the arm that yields blue for an
  // unfinished turn must exist and must come BEFORE the completed→green arm.
  // The earlier version of this gate used `indexOf("'green'")`, which matched the
  // gate's own slicing window rather than the arm — so deleting the blue arm and
  // reordering the arms both stayed green (proven 2026-10-30).
  const inFlightArm = derive.search(/turnInFlight\(record,\s*witnesses\.get\([^)]*\),\s*now,\s*windowMs\)\s*\n?\s*\?\s*'blue'/)
  counted.ok(
    inFlightArm >= 0,
    'B-009：必须有「turnInFlight(record, 见证, now, 窗口) ? blue」这一支 —— 否则 Host 轮询延迟期间会闪灰',
  )
  const greenArm = derive.search(/completedAt !== undefined\s*\n?\s*\?\s*'green'/)
  counted.ok(greenArm >= 0, 'B-009：必须保留「已完成 → 绿」这一支')
  counted.ok(
    inFlightArm < greenArm,
    'B-009：turnInFlight 必须先于「已完成」判定 —— 新 turn 已开始时旧完成不得继续冒充绿色（D-004）',
  )
  // The overlay must actually feed the witnesses in; a pure helper nobody calls
  // is the same as no fix.
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(
    /noteRunning\(watchedRunning\.current/.test(index),
    'B-009：overlay 必须把「见过在跑」喂给 deriveView —— 只写纯函数没人调用等于没修',
  )
  counted.ok(
    /pruneWitnesses\(/.test(index),
    'B-009：overlay 必须回收过期见证，否则长开的页面会累积每个会话一条',
  )
  // The bubble must stay gated on `from === 'blue'`; the fix belongs upstream of it.
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  const transitions = ball.slice(ball.indexOf('export function transitionsOf'), ball.indexOf('export interface TaskballBubbleProps'))
  counted.ok(
    /from !== 'blue'/.test(transitions),
    'B-009：气泡仍只播离开 blue 的边 —— 修复要在 deriveView，不得为此放宽气泡条件',
  )
  // The witness window is judged as `now - stamp <= windowMs` with both numbers
  // taken from the SAME clock, so the clock's step size decides what that
  // comparison means. A step at or above the window turns it into "was the stamp
  // taken during the current step" and silently drops witnesses at every
  // boundary (measured 2026-10-30: 15 s step against this 10 s window repainted
  // finishing sessions gray for 0.1–5.1 s in ~19% of endings).
  //
  // The pure-function tests cannot catch this: they pass an explicit clock, so a
  // regressed `useNow` keeps them green (proven — the timing test stayed green
  // with the old implementation restored). Only the source can be asserted here.
  const hostState = await readFile(path.join(root, 'src/client/host-state.ts'), 'utf8')
  const useNowBody = hostState.slice(hostState.indexOf('export function useNow'))
  counted.ok(
    /return Date\.now\(\)/.test(useNowBody),
    'B-009：useNow 必须返回 Date.now() —— 返回上一次 tick 的时间戳会让见证窗口按 15s 步长退化，每次 tick 误丢见证',
  )
  counted.equal(
    /setNow\(Date\.now\(\)\)/.test(useNowBody),
    false,
    'B-009：useNow 不得把 tick 时间戳存进 state 再返回 —— 那正是把粗时钟当成判据时钟的写法',
  )
  // And the window has to be finer than one render tick for the comparison to
  // mean anything, so keep the two numbers from drifting back together.
  counted.ok(
    /const TICK_MS = 15_000/.test(hostState),
    'B-009：TICK_MS 必须是 15s（只做重渲染节奏）—— 若它被改成与窗口同量级，请重测见证窗口',
  )
  counted.ok(
    /flightWindowMs\(DEFAULT_POLL_MS\)/.test(index),
    'B-009：见证窗口必须是 2×轮询周期，而不是随手拍的时长（D-032/B-008 的教训是不要按时间猜）',
  )
}

// D-053: red must not outlive the poll interval once the user re-enters a failed
// session. The fix gives "a new attempt started" a SECOND witness — the live
// `running` flag, which is event-driven (0 latency) where `turnStartAt` waits for
// the 5s poll. Both must share the one AUTO_CONTINUATION_MS band: giving the live
// witness its own (or no) threshold would let the loop's own retry (231–420ms
// measured) wipe red out before the user ever saw it — the D-025 defect.
{
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  counted.ok(
    /export interface LiveSignal/.test(model),
    'D-053：必须有 LiveSignal（实时 running + now）作为第二证据的类型',
  )
  const failure = model.slice(model.indexOf('export function failureOf'), model.indexOf('export function completedAtOf'))
  counted.ok(
    /live\?: LiveSignal/.test(failure),
    'D-053：failureOf 必须接受实时证据参数，否则用户重进后仍要等一个轮询周期才转蓝',
  )
  // One shared predicate for both witnesses: two separate band comparisons is
  // how the two sources start disagreeing while both are present.
  counted.ok(
    /reenteredSince/.test(failure),
    'D-053：两条证据必须收敛到同一个判据（reenteredSince），不得各写一套阈值比较',
  )
  counted.ok(
    /live\.now - at >= AUTO_CONTINUATION_MS/.test(failure),
    'D-053：实时证据必须套用同一个 1s 时间带 —— 否则宿主自动续跑（实测 231–420ms）会把红刷掉',
  )
  counted.ok(
    /restartAt - at >= AUTO_CONTINUATION_MS/.test(failure),
    'D-053：Host 证据的时间带不得被顺手改宽/改窄（D-025 的取样结论见 DECISION.md）',
  )
  counted.ok(
    /live\?\.running === true/.test(failure),
    'D-053：只有 running === true 才算证据；running false 不得凭空清红',
  )
  const derive = model.slice(model.indexOf('const liveStatus = statuses.get'))
  counted.ok(
    /failureOf\(\s*record,\s*liveStatus\?\.running === true \? \{ running: true, now \}/.test(derive),
    'D-053：deriveView 必须把实时 running 与真实 now 一起传给 failureOf —— 只改函数没人喂等于没修',
  )
}

// F-008: Shift+clicking a red checkbox folds every visible failure at once. The
// guardrail D-006/D-018 puts around red cannot just be dropped for the bulk case:
// the user must see WHICH sessions the action covers before it commits. The
// dialog is that guardrail, so both halves — trigger and confirmation — are locked.
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  // The dialog moved to its own module (refactor 2026-11-01); the trigger path
  // and the commit behaviour remain in `panel.ts`, so both files are read.
  const confirmUi = await readFile(path.join(root, 'src/client/panel-confirm.ts'), 'utf8')
  counted.ok(
    /function RedBulkConfirmDialog/.test(confirmUi),
    'F-008：必须有批量确认弹窗组件 —— 批量折叠红色不得绕过 D-006 的护栏',
  )
  // The modifier lives on `click`, not `change`: a ChangeEvent carries no
  // modifier state, and reading it off `change` neither typechecks nor works.
  counted.ok(
    /onClick: \(event\) => \{ shiftHeldRef\.current = event\.shiftKey === true \}/.test(panel),
    'F-008：Shift 必须在 click 事件上记录（change 事件不带修饰键）',
  )
  counted.ok(
    /requestToggle\(entry, shiftHeldRef\.current\)/.test(panel),
    'F-008：change 必须消费 click 记录的修饰键，否则 Shift 永远不生效',
  )
  const dialog = confirmUi.slice(
    confirmUi.indexOf('function RedBulkConfirmDialog'),
    confirmUi.indexOf('export function RedConfirmBar'),
  )
  counted.equal(
    (dialog.match(/type: 'button'/g) ?? []).length,
    2,
    'F-008：弹窗必须恰好两个选择块（取消 / 确认）',
  )
  counted.ok(/data-taskball-bulk-list/.test(dialog), 'F-008：弹窗必须列出将被折叠的会话')
  counted.ok(/entry\.title/.test(dialog), 'F-008：清单每行必须是会话标题，不是只有数量')
  counted.ok(/palette\.ink\.red/.test(dialog), 'F-008：确认块用调色板墨色，不得写死白字（D-029 对比度规则）')
  counted.ok(/cancelRef\.current\?\.focus\(\)/.test(dialog), 'F-008：焦点默认落在「取消」')
  // Esc is the safe exit and must not fold anything.
  counted.ok(/setBulkRedPending\(\[\]\)/.test(panel), 'F-008：Esc 取消必须清空待折叠集合，一条都不折叠')
  const confirm = panel.slice(panel.indexOf('const confirmBulkRed'), panel.indexOf('const marker ='))
  counted.ok(
    /animateOut\(ids, exitDurationMs\(props\.foldAnimation\)\)/.test(confirm),
    'F-008：确认后红色行必须一起播离场动画（用户 2026-10-30 明确要求）',
  )
  counted.ok(
    /onBulkFold\?\.\(ids, true\)/.test(confirm),
    'F-008：批量折叠必须走一次 onBulkFold，不得 for 循环逐条写 Host',
  )
  counted.equal(/onToggleFolded/.test(confirm), false, 'F-008：批量路径不得退化成逐条 onToggleFolded')
}

// F-010 (D-055): the ring animates by transitioning registered custom properties.
// The whole approach rests on one property of the browser: a conic-gradient is
// only interpolated when the new stop list is structurally identical to the old
// one. So the gradient STRING must be constant and only the values may move —
// assert that, because a "helpful" refactor that inlines a colour or a literal
// angle would silently turn the animation back into a hard cut.
{
  const visual = await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8')
  counted.ok(/export const MAX_ANIMATED_BOUNDARIES/.test(visual),
    'F-010：槽位上限必须是具名常量，否则无法解释超限退化')
  counted.ok(/syntax: '<angle>'/.test(visual),
    'F-010：边界必须以 <angle> 注册 —— 未注册的属性根本无法过渡')
  counted.ok(/syntax: '<color>'/.test(visual),
    'F-010：填充必须以 <color> 注册 —— 否则换色是硬切，不是渐变')
  const animated = visual.slice(visual.indexOf('export function animatedBallGradient'), visual.indexOf('export function sectorVariables'))
  counted.ok(/animatedBallGradient/.test(visual) && /--taskball-c\$\{index\}/.test(animated) === false,
    'F-010：动画渐变必须读取颜色变量，不得内联调色板字面量')
  counted.ok(/function sectorVariables/.test(visual),
    'F-010：必须有把当前扇区写入槽位的函数，否则渐变永远停在初值')
  counted.ok(/export function canAnimateSlices/.test(visual),
    'F-010：必须有超限判断 —— 扇区多于槽位时不能丢扇区')

  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  counted.ok(/--taskball-b0 200ms/.test(style), 'F-010：样式表必须给边界变量过渡时长')
  counted.ok(/--taskball-c0 200ms/.test(style), 'F-010：样式表必须给颜色变量过渡时长')

  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(/animatedBallStyle\(/.test(ball), 'F-010：球必须使用动画样式')
  counted.ok(/canAnimateSlices\(/.test(ball), 'F-010：球必须在超限时退回静态渐变')

  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/registerBoundaryProperties\(\)/.test(index),
    'F-010：apply 必须注册变量 —— 不注册就等于没有过渡')
  counted.ok(
    index.indexOf('injectStyle') < index.indexOf('registerBoundaryProperties()'),
    'F-010：样式注入仍须最前，注册紧随其后（AGENTS §9 的顺序约定）',
  )
}

// F-009 follow-up (D-056): "does it pop up when a task finishes" is the one
// notification question asked while looking at the ball, so the popup surfaces
// it. It must be the SAME field the settings page writes — a second flag for one
// behaviour would drift the first time either surface changed.
{
  const quick = await readFile(path.join(root, 'src/client/quick.ts'), 'utf8')
  counted.ok(/bubbleOnCompletion: boolean/.test(quick),
    'D-056：快捷面板的 values 必须带 bubbleOnCompletion')
  counted.ok(/switchRow\('bubbleOnCompletion'/.test(quick),
    'D-056：快捷面板必须渲染该开关')
  counted.ok(/values\[field\]/.test(quick),
    'D-056：开关的选中态必须直接读 values，不得按字段名写分支（漏字段会静默错）')

  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  const quickValues = index.slice(index.indexOf('const quickValues'), index.indexOf('const quickValues') + 400)
  counted.ok(/bubbleOnCompletion/.test(quickValues),
    'D-056：overlay 必须把该值喂给快捷面板')
  counted.ok(/settingsSession\.writer\.set/.test(index),
    'D-056：开关写入仍必须走唯一 writer（D-046）')
  counted.equal(
    /writeQuickSetting[\s\S]{0,200}form\.mutate/.test(index),
    false,
    'D-056：快捷面板不得绕过 writer 直接 mutate',
  )
}

// D-077（用户 2026-11-03）：气泡开关从「只管完成」升级为**总开关**，且收起态下
// 一律不弹气泡。这两条都是语义变更，必须锁住，否则未来一次重构就会悄悄回退成
// 「红色失败不可静音」或「气泡浮在球原来的空位上」。
{
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  const transitions = ball.slice(
    ball.indexOf('export function transitionsOf'),
    ball.indexOf('export interface TaskballBubbleProps'),
  )
  // 总开关的第一性行为：关掉 = 一条都不发。旧实现里红/黄是硬编码「始终弹」，
  // 那正是用户要推翻的（D-056 的 (b) 曾因此被否）。这条断言是本次改动的核心。
  counted.ok(/if \(!bubbleEnabled\) return \[\]/.test(transitions),
    'D-077：气泡开关关闭时必须一条都不发 —— 连红色失败提醒也要能静音')
  // 开关开着时三种颜色都要弹。绿曾经是「可选的」、红黄是「无条件」，现在统一。
  // 断言写「push 那一行的条件里不得再出现颜色判断」而不是匹配某个具体变量名 ——
  // 第一版锁的是 `to === 'green' && notifyOnCompletion`，负向验证用 bubbleEnabled
  // 做变异时没红：**门禁写得太松**（§13 第 ② 种成因）。判据应是「这行不再按颜色分支」。
  counted.ok(/new Set<TaskballColor>\(\['red', 'yellow', 'green'\]\)/.test(ball),
    'D-077：BUBBLE_WORTHY 必须含 red/yellow/green 三种 —— 绿不再是特例')
  const pushLine = transitions.split('\n').filter((line) => line.includes('transitions.push'))
  counted.ok(pushLine.length > 0, 'D-077：必须有 transitions.push 那一行')
  for (const line of pushLine) {
    counted.equal(/\|\|/.test(line), false,
      `D-077：push 的条件不得再带「|| 额外放行」分支（那会让某个颜色重新变成开关之外的特例）：${line.trim()}`)
    counted.equal(/to === 'green'/.test(line), false,
      `D-077：push 的条件不得再按颜色特判 green：${line.trim()}`)
  }
  // 只播离开 blue 的边：B-009 的既有约束仍然有效，本次不得顺手放宽。
  counted.ok(/from !== 'blue'/.test(transitions),
    'D-077：仍只播离开 blue 的边（B-009 的约束不因本次改动而放宽）')

  // 收起态抑制（方案 B）：气泡锚的是球最后停下的坐标，而收起后那个位置是空的。
  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/bubble === undefined \|\| showStrip/.test(index),
    'D-077：收起态必须不渲染气泡 —— 否则气泡会浮在球原来的空位上')
  // 变量名必须说「总开关」，而不是继续叫 notifyOnCompletion/completion，
  // 否则下一个读代码的人会按旧语义改它（D-009 的老前提）。
  counted.ok(/const bubbleEnabled = settings\.bubbleOnCompletion !== false/.test(index),
    'D-077：overlay 必须按「缺省即开」读该字段（!== false），不是 === true')
}


// 动画渐变的接缝宽度必须是注册过的变量，不能是字面量公式 —— 字面量无法区分
// 「有分界」与「没有分界」，空环时会在 12 点方向画出一道白色楔形。
{
  const visual = await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8')
  counted.ok(/export function seamVar\(/.test(visual),
    'D-057：接缝宽度必须有独立变量名（能归零，且保持渐变字符串恒定）')
  counted.ok(/export function seamAngleOf\(/.test(visual),
    'D-057：接缝宽度必须有单一定义处，供 sectorVariables 与测试共用')
  counted.ok(/span >= 359\.9\) return 0/.test(visual),
    'D-057：满圆槽位不得画接缝 —— 与静态渐变的 span >= 359.9 分支对齐')
  counted.equal(
    /const half = `min\(\$\{SEAM_DEG \/ 2\}deg/.test(visual),
    false,
    'D-057：动画渐变不得再内联接缝公式（那是竖线的直接成因）',
  )
  const animated = visual.slice(visual.indexOf('export function animatedBallGradient'))
  counted.ok(/seamVar\(index\)/.test(animated.slice(0, 1200)),
    'D-057：动画渐变的接缝必须读变量')
  counted.equal(
    /min\(/.test(animated.slice(0, 1200)),
    false,
    'D-057：动画渐变里不得出现 min() —— 接缝宽度已由变量承担',
  )
  counted.ok(/name: seamVar\(index\)[\s\S]{0,120}?syntax: '<angle>'/.test(visual),
    'D-057：接缝宽度必须以 <angle> 注册，否则滑入滑出时会硬跳')

  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  for (const index2 of [0, 7]) {
    counted.ok(new RegExp(`--taskball-s${index2} 200ms`).test(style),
      `D-057：样式表必须给接缝变量 --taskball-s${index2} 过渡时长`)
  }
}

// D-058（用户 2026-10-30 报「球的中心点始终有一个点」）：
// 那个点不是磨砂玻璃盘（用户明确要保留），而是空态额外叠的 `·` 占位字符。
{
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.equal(/}, '·'\)/.test(ball), false,
    'D-058：球上不得再渲染 `·` 占位字符 —— 它就是用户看到的「中心点」')
  // The disc must be RENDERED with the live diameter (D-072): calling it with no
  // argument would silently fall back to the 44px design size and stop scaling
  // again, which is exactly the defect D-072 fixed.
  counted.ok(/ballCenterStyle\(ballSize\)/.test(ball),
    'D-058 / D-072：磨砂玻璃盘必须保留，且必须传入当前球直径')
  const visual = await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8')
  counted.ok(/export function ballCenterStyle/.test(visual),
    'D-058：中心盘样式必须仍有唯一定义处')
  counted.ok(/export function centerPx/.test(visual),
    'D-072：中心盘直径必须有唯一定义处（随球大小缩放）')
}

// D-059（用户 2026-10-30 报「撤销勾选后未处理项自行折叠」）：
// 根因是 React 兄弟节点按 INDEX 匹配。分组 <section> 有 key，它后面的
// 「已处理」<section> 和空态 <div> 也必须都有 key，否则分组增减时会把
// 折叠区卸载重挂，而 <details> 的展开态是 DOM 状态，重挂即丢。
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.ok(/\{ key: 'folded' \}/.test(panel),
    'D-059：「已处理」区必须有显式 key —— 否则分组增减时会卸载重挂，展开态丢失')
  counted.ok(/\{ key: 'empty',/.test(panel),
    'D-059：空态占位也必须有显式 key（它同样排在分组之后）')
  counted.ok(/\{ key: group\.key \}/.test(panel),
    'D-059：工作区分组必须继续按 workspaceId 作 key')
  // 这个容器的子节点里，凡 `h('div'|'section')` 都必须带 key：分组列表本身、
  // 空态占位、已处理区。任何一个缺 key，它后面的兄弟就会按位置错配。
  const tail = panel.slice(panel.indexOf('...groups.map('), panel.lastIndexOf('bulkRedPending.length === 0'))
  const unkeyed = [...tail.matchAll(/h\('(div|section)', \{(?![\s\S]{0,80}?key:)/g)]
  counted.equal(unkeyed.length, 0,
    `D-059：分组之后的每个条件子节点都必须带 key，发现 ${unkeyed.length} 个无 key 的`)
}

// D-060（用户 2026-10-30 要求「绿色也支持 Shift 批量勾选，且不做二次确认」）：
// D-006 的二次确认是为红色设的护栏；已完成条目本来就已完成、会自己过期、
// 且新 turn 会自动撤销折叠，再问一遍只是仪式。红色护栏不得因此被削弱。
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const toggle = panel.slice(panel.indexOf('const requestToggle'), panel.indexOf('const confirmBulkRed'))
  counted.ok(/shiftKey && entry\.color === 'green'/.test(toggle),
    'D-060：Shift+勾绿必须走批量分支')
  counted.ok(/candidate\.color === 'green'/.test(toggle),
    'D-060：绿色批量范围必须按颜色过滤，不得混入其它颜色')
  counted.ok(/onBulkFold\?\.\(ids, true\)/.test(toggle),
    'D-060：绿色批量必须一次 onBulkFold')
  // 绿色批量分支本身不得退化成逐条，也不得打开任何确认。
  const greenBranch = toggle.slice(
    toggle.indexOf("entry.color === 'green'"),
    toggle.indexOf('if (needsRedConfirm'),
  )
  counted.ok(greenBranch.length > 0, 'D-060：必须能定位到绿色批量分支')
  counted.equal(/onToggleFolded/.test(greenBranch), false,
    'D-060：绿色批量分支不得退化成逐条 onToggleFolded')
  counted.equal(/setBulkRedPending|setPendingRed/.test(greenBranch), false,
    'D-060：绿色批量不得打开任何二次确认（用户明确要求）')
  counted.ok(/needsRedConfirm\(entry\.color, folded\.has\(entry\.id\)\)/.test(toggle),
    'D-060：红色二次确认路径必须仍然存在（D-006 护栏不得被削弱）')
}

// D-071（用户 2026-11-02：「快捷面板中的『一键勾选绿色/红色』这几个都可以不要了，
// shift 组合键可以满足了」）：面板首行的三个批量按钮已删除。
//
// 这是「同一个动作的第二个入口」的收口 —— 两个批量行为都还在，只是现在只有
// Shift+勾选一条路径（红走确认弹窗 F-008，绿直接批量 F-013）。门禁锁两件事：
// 按钮不得复活，且被删的只能是按钮、不能顺手削掉 Shift 路径。
{
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const locale = await readFile(path.join(root, 'src/client/locale.ts'), 'utf8')
  counted.equal(/bulkButton/.test(panel), false,
    'D-071：面板首行的批量按钮必须已删除（不得再出现 bulkButton）')
  counted.equal(/data-taskball-bulk="(green|red|both)"/.test(panel), false,
    'D-071：批量按钮不得以别的标记复活')
  counted.equal(/'panel\.bulk(Green|Both)'/.test(locale), false,
    'D-071：随按钮一起删除的文案不得残留')
  // 反向断言：Shift 两条路径必须都还在 —— 删按钮不等于删能力。
  counted.ok(/shiftKey && entry\.color === 'green'/.test(panel),
    'D-071：绿色 Shift 批量路径必须保留（按钮只是它的第二个入口）')
  counted.ok(/shiftKey && needsRedConfirm/.test(panel),
    'D-071：红色 Shift 批量确认路径必须保留（D-006 护栏）')
}

// F-001（用户 2026-10-31 定方案）：草稿会话的灰色呈现。
// 四条约束：不占扇形 / 面板顶部且不分组 / 整行可点无勾选框 / 空则不渲染。
// 草稿信号来自宿主私有存储，解析失败必须退化成「无草稿」。
{
  const drafts = await readFile(path.join(root, 'src/client/drafts.ts'), 'utf8')
  counted.ok(/DRAFT_KEY_PREFIX = 'dsh\.conversation\.'/.test(drafts),
    'F-001：草稿键前缀必须与宿主 dsh-client-ui-conversation 的 persist 键一致')
  counted.ok(/export function hasDraftContent/.test(drafts),
    'F-001：草稿判据必须有唯一定义处')
  counted.ok(/typeof draft === 'string'\) return draft\.trim\(\) !== ''/.test(drafts),
    'F-001：必须兼容旧格式（draft 是纯字符串）且非空白才算草稿 —— 宿主 parseStoredDraft 同样兼容两种')
  counted.ok(/references/.test(drafts),
    'F-001：只有引用没有文字也算草稿（与宿主语义一致）')
  // 解析失败必须吞掉：一个 throw 会经 slot 错误边界把整个 overlay 卸掉
  const parseBody = drafts.slice(drafts.indexOf('export function hasDraftContent'), drafts.indexOf('export function readDraftIds'))
  counted.equal(/throw /.test(parseBody), false,
    'F-001：草稿解析不得抛错（任何畸形输入都退化成「无草稿」）')
  counted.ok(/catch \{/.test(parseBody), 'F-001：JSON.parse 必须包 try/catch')
  counted.ok(/export const DRAFT_POLL_MS = 5000/.test(drafts),
    'F-001：草稿轮询周期必须与 Host 状态轮询同拍（5s）')

  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  counted.ok(/export const NO_DRAFT_IDS/.test(model),
    'F-001：NO_DRAFT_IDS 必须在 model.ts（纯状态机不得 import React 模块）')
  counted.ok(/!session\.blank \|\| draftIds\.has\(session\.id\)/.test(model),
    'F-001：visibleSessions 必须放行「blank 且有草稿」，其余 blank 照旧滤掉')
  // (a) 不占扇区：草稿必须在进入 colors / entries 之前就 continue 掉
  // 切片锚点用「声明行」而不是相邻分支的字面量：分支条件改过名之后，按旧
  // 表达式 indexOf 会返回 -1，切片变空，后面几条断言就在空字符串上空转通过
  // （本仓库已记录四次同类事故）。
  const draftBranch = model.slice(model.indexOf('const hasTaskState ='),
    model.indexOf('colors.set(session.id, color)'))
  counted.ok(draftBranch.length > 0,
    'F-001：草稿判定切片的锚点必须仍然存在（空切片会让后面的断言空转通过）')
  // 用户 2026-10-31：「新会话没有标题的就叫新会话」。titleOf() 会退回 sessionId，
  // 草稿条目绝不能走那条路 —— 必须留空并由面板换成 i18n 文案。
  // 这一条排在结构分支之前：用 titleOf 的变异会同时破坏 untitled 的推导，
  // 先查它才能让报错指向真正的病因。
  counted.equal(/titleOf\(session\)/.test(draftBranch), false,
    'F-001：草稿条目不得用 titleOf() —— 它会退回 sessionId，而用户要的是「新会话」')
  counted.ok(/drafts\.push\(/.test(draftBranch) && /continue/.test(draftBranch),
    'F-001：草稿条目必须在写入 colors/entries 之前 continue —— 这是「不占扇区」的结构保证')
  // 用户 2026-10-31 真机报障：旧会话有草稿且完成态已过期时，面板两处都没有。
  // 根因是 isGreenExpired 的 continue 排在草稿分支之前。三条门禁锁住顺序：
  // ① 草稿分支必须排在过期的 continue 之前；
  // ② 「有任务状态」的判据必须把 expired 算进去（否则过期绿仍被当成任务状态）；
  // ③ 过期判定不得再以裸 continue 出现在草稿分支之前。
  counted.ok(draftBranch.indexOf('if (draftIds.has(session.id)') !== -1,
    'F-001：切片内必须能找到草稿分支')
  // 条件本身也要锁：只锁位置的话，「改成 color === 'gray'」仍能让顺序门禁全绿，
  // 但过期绿又会被排除在草稿区外（负向验证实测漏检过一次）。
  counted.ok(/if \(draftIds\.has\(session\.id\) && !hasTaskState\)/.test(model),
    'F-001：草稿分支的条件必须是 !hasTaskState —— 用裸 color 判据会让过期绿进不了草稿区')
  counted.ok(draftBranch.indexOf('if (expired) continue') !== -1,
    'F-001：切片内必须能找到过期退场')
  counted.ok(draftBranch.indexOf('if (draftIds.has(session.id)') < draftBranch.indexOf('if (expired) continue'),
    'F-001：草稿分支必须排在「过期退场」之前 —— 过期的绿不得吞掉草稿（2026-10-31 真机缺陷）')
  counted.ok(/const hasTaskState = color !== 'gray' && !expired/.test(model),
    'F-001：「有任务状态」必须把 expired 算进去 —— 过期绿已经不再是可见任务状态')
  counted.equal(/if \(isGreenExpired\([^)]*\)\) continue/.test(model), false,
    'F-001：不得再用裸 isGreenExpired continue —— 它会把带草稿的会话整条吞掉')
  counted.ok(/readonly drafts: readonly DraftEntry\[\]/.test(model),
    'F-001：DerivedView 必须带独立的 drafts 列表（不是塞进 entries）')
  counted.ok(/readonly untitled: boolean/.test(model),
    'F-001：DraftEntry 必须带 untitled 标记（面板据此决定显示「新会话」）')
  counted.ok(/untitled: display === ''/.test(model),
    'F-001：untitled 必须由「标题为空」推导，而不是由 sessionId 兜底')

  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  counted.ok(/props\.view\.drafts \?\? \[\]/.test(panel),
    'F-001：面板读 drafts 必须容忍缺失（否则一个 throw 会卸掉整个 overlay）')
  // The draft section's opening tag now spans several lines (it carries the
  // divider style). Slice from the STABLE anchor (`data-taskball-drafts`) instead
  // of from the guard expression, so a mutated guard cannot silently empty the
  // slice and make the structural assertions below pass vacuously.
  const draftSection = panel.slice(panel.indexOf("'data-taskball-drafts': 'true'"), panel.indexOf('...groups.map('))
  counted.ok(draftSection.length > 0, 'F-001：草稿区必须是一个独立 section')
  // The guard runs FIRST: it is the one every other assertion depends on being
  // present, and a mutated guard would otherwise be reported by an unrelated gate.
  counted.ok(/drafts\.length === 0\n\s+\? null\n\s+: h\('section', \{/.test(panel.replace(/\r\n/g, '\n')),
    'F-001：无草稿时整区不渲染（`drafts.length === 0 ? null : ...` 必须是草稿区的守卫）')
  counted.equal(/data-taskball-check/.test(draftSection), false,
    'F-001：草稿行不得有勾选框（草稿没有「已处理」语义）')
  counted.equal(/checkbox/.test(draftSection), false, 'F-001：同上')
  counted.ok(/onOpenSession\(draft\.id\)/.test(draftSection),
    'F-001：草稿行整行可点并跳转到该会话')
  counted.ok(/active\.length === 0 && drafts\.length === 0/.test(panel),
    'F-001：有草稿时不得再报「暂无任务状态」（否则与下方草稿行自相矛盾）')
  // 用户 2026-10-31：「草稿区和下方的工作区树之间加一个分隔线，草稿区为空时
  // 分隔线也要消失」。分隔线必须是草稿区自身的 border —— 这样它不可能比草稿区
  // 活得久，不需要第二个 drafts.length 判断去保持同步。
  counted.ok(/data-taskball-drafts': 'true',[\s\S]{0,240}?borderBottom: '1px solid var\(--dsw-alias-border-l2/.test(panel),
    'F-001：草稿区必须有底部分隔线（走主题感知的 --dsw-alias-border-l2）')
  counted.equal(/key: 'draft-divider'/.test(panel), false,
    'F-001：分隔线不得做成独立兄弟元素 —— 那样草稿区为空时它会留下')
  // 位置：草稿区必须排在分组之前
  counted.ok(
    panel.indexOf("h('section', { key: 'drafts'") < panel.indexOf('...groups.map('),
    'F-001：草稿区必须在工作区分组之上（用户 2026-10-31：「最上面」）',
  )
  // 用户 2026-10-31：草稿区里的「工作区新会话」与「旧会话的草稿」难以分辨，
  // 工作区新会话行最左侧要加宿主的文件夹图标。
  //
  // 判据必须是宿主的 `blank`（折叠前缀无 turn）而不是标题 —— displayTitleOf()
  // 对空白会话退回 cwd 推导的工作区名，所以「有标题」区分不出这两种行。
  counted.ok(/readonly newConversation: boolean/.test(model),
    'F-001：DraftEntry 必须带 newConversation（工作区新会话标记）')
  counted.ok(/newConversation: session\.blank === true/.test(model),
    'F-001：newConversation 必须由宿主的 blank 推导，不得按标题猜')
  // The inlined host glyphs live in their own module (refactor 2026-11-01). They
  // are still asserted verbatim — only the file they are read from changed.
  const icons = await readFile(path.join(root, 'src/client/panel-icons.ts'), 'utf8')
  counted.ok(/function HostIcon\(/.test(icons),
    'F-001：图标必须有独立组件（渲染逻辑集中一处）')
  counted.ok(/function draftIcon\(/.test(icons),
    'F-001：草稿行的图标选择必须有单一入口')
  counted.ok(/FOLDER_ICON_PATHS/.test(icons), 'F-001：文件夹图标路径必须是命名常量')
  counted.ok(/QUEUE_ICON_PATHS/.test(icons), 'F-001：气泡图标路径必须是命名常量')
  // 内联复制的正确性：16×16 视口、Regular 粗细、各自的 path 数。
  // Slice each constant by its own declaration through the closing `]` on its own
  // line — NOT by "up to the next identifier" (a renamed constant made indexOf
  // return -1 and the slice silently swallowed both blocks), and not by the first
  // `[` (that hits the `string[]` in the type annotation).
  // From the first constant through the END of `HostIcon`, which is where the
  // viewBox / strokeWidth / aria-hidden actually live. Stopping at the function
  // HEADER would make the three assertions below test an empty string.
  const iconBody = icons.slice(icons.indexOf('export const FOLDER_ICON_PATHS'), icons.indexOf('export function draftIcon'))
  const pathCount = (name) => {
    const match = iconBody.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`))
    return match === null ? 0 : (match[1].match(/M[0-9]/g) ?? []).length
  }
  counted.equal(pathCount('FOLDER_ICON_PATHS'), 2,
    'F-001：宿主那个文件夹图标是两条 path（轮廓 + 中间横线），少一条就不是同一个图标')
  counted.equal(pathCount('QUEUE_ICON_PATHS'), 3,
    'F-001：宿主那个队列/气泡图标是三条 path（两条横线 + 轮廓），少一条就不是同一个图标')
  counted.ok(/viewBox: '0 0 16 16'/.test(iconBody), 'F-001：图标必须是宿主的 16×16 视口')
  // 粗细现在是参数：草稿行要 Regular（1），首行两个控件要 Medium（1.3，F-022）。
  // 断言从「字面量 1」改成「默认值必须是 ICON_STROKE」，否则加参数就等于偷偷
  // 放宽了这条 —— 而草稿行那两个图标必须仍是 Regular。
  counted.ok(/strokeWidth: props\.strokeWidth \?\? ICON_STROKE/.test(iconBody),
    'F-001：HostIcon 的默认粗细必须是 Regular（ICON_STROKE），F-022 的 Medium 只能由调用点显式指定')
  counted.ok(/const ICON_STROKE = 1\b/.test(icons), 'F-001：Regular 粗细常量必须是 1')
  counted.ok(/'aria-hidden': true/.test(iconBody),
    'F-001：图标必须 aria-hidden —— 它只重复行标题已有的信息，不得成为第二样朗读内容')
  // 用户 2026-10-31：两种行都要有图标，靠形状区分（之前旧会话行留白，看起来一样）。
  counted.ok(/draftIcon\(draft\.newConversation/.test(panel),
    'F-001：每一行草稿都必须挂图标，形状由 newConversation 决定')
  counted.equal(/draft\.newConversation \? HostIcon\([^)]*\) : null/.test(panel), false,
    'F-001：不得再回到「只有新会话有图标」的写法 —— 那正是两种行难以分辨的原因')
  // 光「有图标」不够：两个图标必须是不同的几何，否则区分不了。
  // 这条曾被负向验证抓出来（把三元改成恒取文件夹，其余门禁全绿）。
  counted.ok(/newConversation \? FOLDER_ICON_PATHS : QUEUE_ICON_PATHS/.test(icons),
    'F-001：图标必须按 newConversation 二选一（文件夹 / 气泡），不得恒取其一')
  // 计划 (b)：图标内联，绝不 require 宿主的 primitives 种子模块。
  // 只查真实的 require 调用，不查注释里的包名（注释会提到它解释为什么不用）。
  const primitiveRequires = [...client.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)]
    .map((match) => match[2])
    .filter((specifier) => specifier.includes('primitives'))
  counted.deepEqual(primitiveRequires, [],
    'F-001：不得 require @deepseek-ai/dsh-client-ui-primitives —— 它是平台种子模块不是依赖包')

  // F-022（用户 2026-11-03）：面板首行的齿轮与关闭从「文本字符」换成宿主图标。
  //
  // 判据是「文字字符必须真的消失」，不是「加了 SVG」—— 只加不删会让两个东西
  // 叠在一起，而静态渲染断言照样能过。同时锁住三件事：
  // ① 两个控件都用 Medium 粗细（1.3），否则齿轮细、× 粗，正是这次要修的毛病；
  // ② 齿轮的外轮廓必须带 strokeMiterlimit:10，宿主原文如此，丢了尖角会削平；
  // ③ 无障碍契约（aria-label / data-taskball-quick-trigger）不得因换图标而改。
  const quickSrc = await readFile(path.join(root, 'src/client/quick.ts'), 'utf8')
  counted.equal(/\u2699/.test(panel), false,
    'F-022：面板首行不得再出现 ⚙ 文本字符（换成宿主齿轮图标后必须删掉）')
  counted.ok(/gearIcon\(\)/.test(panel), 'F-022：面板首行的设置入口必须渲染 gearIcon()')
  counted.ok(/closeIcon\(\)/.test(panel), 'F-022：面板的关闭按钮必须渲染 closeIcon()')
  counted.ok(/closeIcon\(\)/.test(quickSrc), 'F-022：快捷面板的关闭按钮也必须同步换成 closeIcon()')
  counted.ok(/'data-taskball-quick-trigger'/.test(panel),
    'F-022：换图标不得丢掉 data-taskball-quick-trigger —— 门禁与测试都靠它定位入口')
  counted.ok(/'aria-label': t\('panel\.close'\)/.test(panel),
    'F-022：换图标不得丢掉关闭按钮的 aria-label')
  counted.ok(/const ICON_STROKE_MEDIUM = 1\.3/.test(icons),
    'F-022：Medium 粗细必须是 1.3（宿主 Icon*OutlineMedium 的原值）')
  counted.ok(/gearIcon\(\): React\.ReactElement \{\s*return HostIcon\(\{ paths: GEAR_ICON_PATHS, strokeWidth: ICON_STROKE_MEDIUM \}\)/.test(icons),
    'F-022：齿轮必须用 Medium 粗细（与 × 同一档），不得回落到默认 Regular')
  counted.ok(/closeIcon\(\): React\.ReactElement \{\s*return HostIcon\(\{ paths: CLOSE_ICON_PATHS, strokeWidth: ICON_STROKE_MEDIUM \}\)/.test(icons),
    'F-022：关闭图标必须与齿轮同一档粗细')
  counted.ok(/miterlimit: 10/.test(icons),
    'F-022：齿轮外轮廓必须带 strokeMiterlimit 10（宿主原文，丢了凹角会被削平）')
  counted.ok(/strokeMiterlimit: miterlimit/.test(icons),
    'F-022：strokeMiterlimit 必须真的渲染到 path 上，不能只存在常量里')
  counted.ok(/newConversation \? FOLDER_ICON_PATHS : QUEUE_ICON_PATHS, size, strokeWidth: ICON_STROKE/.test(icons),
    'F-022：草稿行图标必须显式指定 Regular 粗细 —— 加了参数不等于它们该跟着变粗')

  const index = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/useDraftIds\(\)/.test(index), 'F-001：overlay 必须接入 useDraftIds')
  counted.ok(/draftIds,\s*\n\s*\)/.test(index), 'F-001：draftIds 必须喂给 deriveView')
  // The string tables moved to their own module (refactor 2026-11-01); the key
  // must exist in BOTH languages, which is only checkable where they are defined.
  const localeStrings = await readFile(path.join(root, 'src/client/locale.ts'), 'utf8')
  counted.ok(/'panel\.drafts'/.test(localeStrings), 'F-001：草稿区标题必须有中英文案')
}

// F-023 第三方皮肤改写 dialog 背景的防护（2026-11-03 核查 open-sea-skin 1.2.6）。
//
// open-sea-skin 有一条 `body :is([role="dialog"], …) { background: … !important }`，
// 会命中本插件三个 role="dialog" 浮层。样式表的 !important 压过普通内联声明，
// 所以内联 background 自己防不住。修法是把值走自定义属性，由我们自己的
// !important 规则消费。
//
// 判据必须锁「两半都在」：
// ① 样式表里那条规则存在且带 !important（少了它，自定义属性就只是摆设）；
// ② 三个浮层都真的设置了对应的自定义属性（少了它，规则读到 undefined）。
// 只锁一半的写法会在另一半点被删时静默通过 —— 这正是 §13 的第 ② 种成因。
{
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  const panel = await readFile(path.join(root, 'src/client/panel.ts'), 'utf8')
  const quick = await readFile(path.join(root, 'src/client/quick.ts'), 'utf8')
  const confirm = await readFile(path.join(root, 'src/client/panel-confirm.ts'), 'utf8')

  counted.ok(/html body \[data-taskball-panel\]\[data-open\],\s*\n\s*html body \[data-taskball-quick\]\[role="dialog"\]\s*\{\s*\n\s*background: var\(--taskball-surface-fill\) !important;/.test(style),
    'F-023：面板与快捷面板必须由带 !important 的规则消费 --taskball-surface-fill')
  counted.ok(/html body \[data-taskball-bulk-confirm\]\[aria-modal="true"\]\s*\{\s*\n\s*background: var\(--taskball-backdrop-fill\) !important;/.test(style),
    'F-023：批量确认的遮罩必须由带 !important 的规则消费 --taskball-backdrop-fill')
  // 第三轮（0.8.9）：皮肤 1.2.7 给自己加了 :not(#自己的id)，ID 选择器计入特异性，
  // 深色那条从 (0,2,1) 跳到 (1,2,1)，我们 (0,2,2) 在 ID 列输。算特异性追不上它，
  // 因为对方每修一次自己的 bug 就把选择器改得更宽/更深。
  // @layer 是退出这场竞赛：对 !important 声明，分层的一律压过未分层的，与特异性无关。
  // 2026-11-03 实测：层内 (0,1,0) 仍赢合成出来的 (3,3,1)。
  // 所以这里锁两件事：① 整块规则必须在 @layer 内；② 规则本身仍在（分层不能当删除的借口）。
  counted.ok(/@layer\s+taskball-defense\s*\{/.test(style),
    'F-023：防护规则必须包在 @layer taskball-defense 里（分层才让特异性失效，这是 1.2.7 之后的唯一稳定解）')
  const layerOpen = style.indexOf('@layer taskball-defense {')
  const layerClose = style.indexOf('\n}', layerOpen)
  counted.ok(layerOpen !== -1 && layerClose !== -1,
    'F-023：@layer 块必须有闭合大括号')
  if (layerOpen !== -1 && layerClose !== -1) {
    const inside = style.slice(layerOpen, layerClose)
    counted.ok(/\[data-taskball-panel\]\[data-open\]/.test(inside),
      'F-023：面板规则必须在 @layer 块内，不能留在层外（层外的 !important 会被皮肤的 ID 选择器压过）')
    counted.ok(/\[data-taskball-quick\]\[role="dialog"\]/.test(inside),
      'F-023：快捷面板规则必须在 @layer 块内')
    counted.ok(/\[data-taskball-bulk-confirm\]\[aria-modal="true"\]/.test(inside),
      'F-023：遮罩规则必须在 @layer 块内')
  }
  // 特异性是这条修复能否生效的关键，不是风格问题。皮肤有两条规则，深色那条
  // 更难压过：
  //   body :is([role="dialog"])                      (0,1,1)  浅色
  //   body[data-ds-dark-theme] :is([role="dialog"])  (0,2,1)  深色
  // 所以门槛是 (0,2,1) 而不是 (0,1,1)。2026-11-03 装上真皮肤（深色）实测：
  //   [data-taskball-panel]                        (0,1,0)  输
  //   body [data-taskball-panel]                   (0,1,1)  输
  //   html body [data-taskball-panel]              (0,1,2)  **输给深色那条**
  //   html body [data-taskball-panel][data-open]   (0,2,2)  赢
  // 第一版修复正是停在 (0,1,2)，浅色下看着好了、深色下静默失效。
  counted.ok(/html body \[data-taskball-panel\]\[data-open\]/.test(style),
    'F-023：防护规则必须到 (0,2,2)（html body + 两个属性），(0,1,x) 会被深色主题那条 (0,2,1) 压过')
  counted.equal(/^\[data-taskball-panel\],/m.test(style), false,
    'F-023：不得回落到裸 [data-taskball-panel] 选择器（(0,1,0) 必输给皮肤）')
  counted.equal(/^body \[data-taskball-panel\]/m.test(style), false,
    'F-023：不得回落到 body [data-taskball-panel]（(0,1,1) 平手后因注入顺序而输）')
  counted.ok(/'--taskball-surface-fill': panelBackground/.test(panel),
    'F-023：面板必须设置 --taskball-surface-fill（否则那条规则读到 undefined）')
  counted.ok(/'--taskball-surface-fill': MENU_SURFACE_FILL/.test(quick),
    'F-023：快捷面板必须设置 --taskball-surface-fill')
  counted.ok(/'--taskball-backdrop-fill':/.test(confirm),
    'F-023：批量确认遮罩必须设置 --taskball-backdrop-fill')
  // 反过来锁：不许把值写成内联 `!important`。React 用 style[name] = value 赋值，
  // 带 !important 的值会被浏览器静默丢弃（2026-11-03 实测），于是「加了 !important
  // 却没生效」比不加更糟 —— 它看起来像已经修好了。
  // 两个必须的细节：
  // ① 先剥掉注释行 —— 源码注释里就有 `background: … !important`（解释皮肤那条规则），
  //    不剥的话这条门禁会被自己的文档误报（§13 第 ② 种成因：注释里也有）。
  // ② 与下一条分工：这条只认「background 与 !important 同行」，下一条只认
  //    「有 background: panelBackground」，否则一条会先抓住另一条的变异。
  const codeOnly = [panel, quick, confirm]
    .map((src) => src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'))
    .join('\n')
  counted.equal(/background:\s*[^\n]*!important/.test(codeOnly), false,
    'F-023：不得用内联 background 带 !important（React 会静默丢弃，看起来修好了其实没有）')
  // 内联 background 仍要保留：不是所有宿主都有那条皮肤规则，没有它时这就是唯一来源。
  counted.ok(/background: panelBackground,/.test(panel), 'F-023：面板仍须保留普通内联 background 作为基线')
  counted.ok(/background: MENU_SURFACE_FILL,/.test(quick), 'F-023：快捷面板仍须保留普通内联 background')
}

// F-021 收起态竖条（用户 2026-10-31 草图 + 12 条批注，D-063）。
// 用户逐条拍板的约束，每条都要有门禁守着，否则下次改动会静默丢掉其中一条。
{
  const strip = await readFile(path.join(root, 'src/client/ball-strip.ts'), 'utf8')
  const ball = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  const model = await readFile(path.join(root, 'src/client/model.ts'), 'utf8')
  const quick = await readFile(path.join(root, 'src/client/quick.ts'), 'utf8')

  // ⑪ 段序按 F-007 草案 红 > 黄 > 蓝 > 绿，且必须与球环共用同一个排序 owner。
  counted.ok(/export const COLOR_ORDER: readonly TaskballColor\[\] = \['red', 'yellow', 'blue', 'green'\]/.test(model),
    'F-021：显示顺序必须是 红 > 黄 > 蓝 > 绿（COLOR_ORDER 是唯一 owner）')
  counted.equal(/COLOR_PRIORITY/.test(model), false,
    'F-021：旧名 COLOR_PRIORITY 必须已改为 COLOR_ORDER —— 两个名字会各自漂移')
  const orderBody = model.slice(model.indexOf('export function orderEntries('), model.indexOf('export function sectorAngles('))
  counted.ok(orderBody.length > 100, 'F-021：orderEntries 切片必须非空（空切片会让后面的断言空转通过）')
  counted.ok(/COLOR_ORDER\.indexOf/.test(orderBody), 'F-021：排序必须读 COLOR_ORDER，不得自己再写一份颜色数组')
  counted.ok(/left\.updatedAt !== right\.updatedAt/.test(orderBody) && /left\.id < right\.id/.test(orderBody),
    'F-021：同色必须用 updatedAt + id 兜底 —— 只按颜色排会让同位次条目在两次渲染间互换，扇区乱转')
  counted.ok(/orderEntries\(entries\.filter\(/.test(model),
    'F-021：球环 sectorAngles 必须走同一个 orderEntries，否则条和环会各说一套顺序')
  counted.ok(/orderEntries\(sectorEntries\(entries, folded\)\)/.test(strip),
    'F-021：竖条必须走同一个 orderEntries + 同一个 sectorEntries（occupy 判据的单一 owner）')
  // 竖条只能显示「未处理」条目（用户 2026-10-31 报障：收起后连已处理项也画了）。
  // 判据必须是「走 occupiesSector 那个谓词」，不是「自己再写一遍 !folded.has(id)」——
  // 后者正是 D-005 / D-028 否决过的双口径：两个等价过滤会各自漂移。
  //
  // Strip comments first: this file NAMES `!folded.has(id)` in prose to explain why
  // it must not be re-spelled, so a naive substring gate fails on its own docs.
  const stripCode = strip
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  counted.equal(/folded\.has\(/.test(stripCode), false,
    'F-021：竖条不得自己判 folded —— 必须经 sectorEntries / occupiesSector 这个唯一谓词')
  counted.ok(/readonly folded\?: ReadonlySet<string>/.test(strip),
    'F-021：竖条必须接收 folded 集合，否则无法排除已处理项')
  counted.ok(/stripSegments\(props\.entries, props\.folded\)/.test(strip),
    'F-021：组件必须把 folded 真的传给 stripSegments（只定义参数不算）')

  // ① / ⑫ 无任务显示一段中性灰，整条不消失。
  counted.ok(/\{ color: 'gray', id: '__empty__' \}/.test(strip),
    'F-021：无任务时必须返回一段灰色（不是空数组 —— 那会让竖条整个消失）')

  // ② 段高 < 4px 不画缝。
  counted.ok(/export const MIN_SEAM_SEGMENT_PX = 4/.test(strip), 'F-021：段高下限必须是 4px')
  counted.ok(/heightPx \/ segmentCount >= MIN_SEAM_SEGMENT_PX/.test(strip),
    'F-021：不画缝的判据必须是「段高 < 4px」本身，不能换成别的近似条件')

  // ⑧ 缝色走主题 token，不得写死（D-037 的教训）。
  counted.ok(/--dsw-alias-border-l2/.test(strip), 'F-021：缝色必须走宿主主题 token')
  const seamLines = [...strip.matchAll(/boxShadow:[^\n]*/g)].map((match) => match[0])
  counted.ok(seamLines.length > 0 && seamLines.every((line) => !/#[0-9a-fA-F]{3,6}\b/.test(line)),
    'F-021：缝的 boxShadow 不得出现写死的 hex —— 深色主题下会发脏')

  // ④ 真实 button + type + aria-label；不得是可点击 div。
  counted.ok(/h\('button', \{/.test(strip), 'F-021：竖条必须是真实 <button>，不能是可点击 div')
  counted.ok(/type: 'button'/.test(strip), 'F-021：button 必须显式声明 type="button"，否则会继承 submit')
  counted.ok(/aria-label/.test(strip), 'F-021：竖条必须有不依赖颜色的可访问名')

  // ⑨ 颜色即状态色，且必须读传入的 palette（色盲模式 D-031 要跟着换）。
  counted.ok(/palette\.hex\[segment\.color\]/.test(strip),
    'F-021：段填充必须读 palette.hex，色盲模式才换得掉')
  const stripWithoutRgba = strip.replace(/rgba\([^)]*\)/g, '')
  counted.equal(/#[0-9a-fA-F]{6}\b/.test(stripWithoutRgba), false,
    'F-021：竖条不得自带状态色字面量 —— 颜色只在 palette.ts 定义（D-030）')

  // ③ 点击/悬停回到「收起前的坐标」，不是回到吸附线。
  counted.ok(/initialPosition\?: BallPosition \| undefined/.test(ball),
    'F-021：球必须接受 initialPosition，否则收起后无法精确复原')
  counted.ok(/applyLayout\(props\.initialPosition \?\? stored\?\.position\)/.test(ball),
    'F-021：复原必须优先用记住的坐标，而不是 localStorage 里最后一次落盘的位置')
  // 批注 ④：hover 纯视觉，只有 CLICK 复原。这条曾被实现成「悬停即复原」并被用户
  // 当场发现（指针掠过竖条，球就瞬移回原位），所以必须由门禁锁住：
  // 竖条不再有悬停回调，复原只挂在 onClick 上。
  counted.equal(/onHoverStart|onHoverEnd/.test(strip), false,
    'F-021：竖条不得有悬停回调 —— 悬停不得复原成球（批注 ④：点击才复原）')
  counted.ok(/onClick: props\.onRestore/.test(strip),
    'F-021：复原必须挂在 onClick 上')

  // ⑩ 竖条是球的替代品，不能两个同时渲染。
  const indexAlt = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/showStrip && stripPlacement !== undefined\s*\?\s*h\(TaskballStrip/.test(indexAlt),
    'F-021：竖条与球必须是二选一（三元的两个分支），不得同时渲染')
  counted.ok(/collapsedFrom\.current = anchor/.test(indexAlt),
    'F-021：收起时必须记下当时的球坐标（批注 ③：回到收起前的坐标）')
  // 批注 ④ 的第二半：overlay 不得再持有 hover 状态来切换「条/球」渲染。曾经的
  // 实现是 `showStrip = collapsedActive && !stripHovered`，结果指针一掠过竖条，
  // 球就瞬移回原位 —— 用户当场报障。
  counted.equal(/stripHovered|setStripHovered/.test(indexAlt), false,
    'F-021：overlay 不得用 hover 状态切换「条/球」渲染（批注 ④：只有点击复原）')
  // 必须锁到「整行为该表达式为止」：只用 `const showStrip = collapsedActive\b`
  // 是松的 —— 后面接 `&& 别的条件` 照样命中，负向验证实测漏过一次。
  counted.ok(/const showStrip = collapsedActive\r?\n/.test(indexAlt),
    'F-021：showStrip 必须就是 collapsedActive 本身，不得再叠加任何条件')
  // 悬停不得挂在竖条上。查的是「任何指针/悬停进入类处理器」，不是某个具体名字 ——
  // 负向验证用 onPointerEnter 绕过了只匹配 onHoverStart 的旧门禁。
  counted.equal(/onPointerEnter|onPointerLeave|onMouseEnter|onMouseLeave|onPointerOver|onPointerOut/.test(strip), false,
    'F-021：竖条不得绑定任何指针/悬停处理器 —— 悬停只改样式，不得复原成球')

  // ⑤ / ⑥ 两道门槛：触屏不启用；沟不够宽不启用。
  counted.ok(/matchMedia\?\.\('\(pointer: coarse\)'\)\.matches === true/.test(indexAlt),
    'F-021：触屏必须整体关闭收起态（批注 ⑤）')
  counted.ok(/const canCollapse = stripPlacement !== undefined && !coarsePointer/.test(indexAlt),
    'F-021：能否收起必须同时受「放得下」与「非触屏」两个条件约束')
  counted.ok(/export function stripGutterBudget/.test(ball),
    'F-021：沟宽预算必须有具名函数（条 + 间隙 + 一整个球），不得散落魔法数字')
  // 光「有这个名字」不够 —— 负向验证实测过：把判据换成写死的 61 时，函数仍在、
  // 门禁全绿。必须同时锁住「它被真的调用」和「不得有第二份算术」。
  // F-018 之后调用多带一个 ballSize：预算 = 条 + 间隙 + 一整个球，球多大预算就多宽。
  counted.ok(/gap < stripGutterBudget\(stripWidth, gapPx, ballSize\)/.test(ball),
    'F-021：stripBox 必须真的调用 stripGutterBudget，而不是只定义它')
  counted.equal(/gap < stripWidth \+ gapPx \+ \d+/.test(ball), false,
    'F-021：不得再出现写死的 44 —— 预算必须走 stripGutterBudget')

  // 锚点：官方 [data-rightbar-col]，不得再依赖第三方注入的 data-dsh-center-col。
  counted.ok(/querySelector\('\[data-rightbar-col\]'\)/.test(ball),
    'F-021：吸附线必须读官方 [data-rightbar-col]')
  counted.equal(/querySelector\('\[data-dsh-center-col\]'\)/.test(ball), false,
    'F-021：不得再依赖第三方插件注入的 data-dsh-center-col（它可能根本不存在）')
  counted.ok(/previousElementSibling/.test(ball),
    'F-021：中心列必须由 [data-rightbar-col] 的前一个兄弟推出')
  counted.ok(/querySelector\('\[data-composer-card\]'\)/.test(ball),
    'F-021：竖条位置必须由宿主官方 [data-composer-card] 推导')
  counted.ok(/if \(rect\.width <= 0\) return \{\}/.test(ball),
    'F-021：中心列零宽 = 还没布局完，必须降级而不是把球钉在 x=0')

  // ⑦ 收起是快捷面板里的手动动作，不是自动吸附即收起。
  counted.ok(/quick\.collapse/.test(quick) && /onCollapse/.test(quick),
    'F-021：快捷面板必须有收起入口')
  counted.ok(/data-taskball-collapse/.test(quick), 'F-021：收起按钮需要稳定的测试/定位锚点')
  // The strings live in the locale module now (refactor 2026-11-01).
  const localeAlt = await readFile(path.join(root, 'src/client/locale.ts'), 'utf8')
  counted.ok(/'quick\.collapse'/.test(localeAlt) && /'strip\.restore'/.test(localeAlt),
    'F-021：收起与复原文案必须中英文齐全')
}

// D-074（用户 2026-11-02：「给竖条最外侧加一个白框」）：竖条四周的描边。
//
// 五条约束，各自对应一条已记录的教训：
//   ① 必须是 1px —— 0.5px 在 1x 屏会被抗锯齿吃掉（D-065 气泡描边的原话）；
//   ② 白框必须用 border + border-box，不能用外扩的 box-shadow 环 —— 否则视觉盒子
//      比 STRIP_WIDTH 宽，ball.ts 里「这条沟放不放得下」的预算就不再成立（D-044）；
//   ③ 白框在浅色主题下与背景同色（实测 rgb(255,255,255)），所以必须再有一道
//      贴边的 edge 提供对比 —— 否则「白框」等于不存在（真机像素采样为证）；
//   ④ 那道 edge 必须走主题变量，不能写死墨色（D-037 的同类教训）；
//   ⑤ 段仍靠 flex 等分，描边不得侵入段高计算。
{
  const strip = await readFile(path.join(root, 'src/client/ball-strip.ts'), 'utf8')
  const style = await readFile(path.join(root, 'src/client/style.ts'), 'utf8')
  counted.ok(/export const STRIP_FRAME_PX = 1/.test(strip),
    'D-074：描边宽度必须是具名常量 1px（0.5px 在 1x 屏会被抗锯齿吃掉，D-065）')
  counted.ok(/border: `\$\{STRIP_FRAME_PX\}px solid \$\{STRIP_FRAME_COLOR\}`/.test(strip),
    'D-074：白框必须是真正的 border（border-box 下盒子宽度不变）')
  counted.ok(/STRIP_FRAME_COLOR = 'rgba\(255, 255, 255, 0\.92\)'/.test(strip),
    'D-074：白框必须是白色 —— 这是用户要的视觉语言，不得悄悄换成深色')
  // ③④ 白框之外必须还有一道贴边，且它走主题变量
  counted.ok(/export const STRIP_EDGE_COLOR = 'var\(--taskball-strip-edge/.test(strip),
    'D-074：必须有一道贴边提供对比，否则白框在浅色主题下不可见（真机实测）')
  counted.ok(/boxShadow: `0 0 0 \$\{STRIP_FRAME_PX\}px \$\{STRIP_EDGE_COLOR\}`/.test(strip),
    'D-074：贴边必须是 box-shadow（不占布局宽度），且紧贴白框外侧')
  counted.ok(/\[data-taskball-strip\] \{ --taskball-strip-edge:/.test(style),
    'D-074：style.ts 必须声明浅色主题的贴边色')
  counted.ok(/body\[data-ds-dark-theme\] \[data-taskball-strip\] \{ --taskball-strip-edge:/.test(style),
    'D-074：深色主题必须换用另一套贴边色（宿主深色标记是 body[data-ds-dark-theme]）')
  // ⑤ 段仍靠 flex 等分
  counted.ok(/flex: '1 1 0px'/.test(strip),
    'D-074：加框后段仍必须靠 flex 等分，不得改成按高度计算')
}

// F-018 第一步（用户 2026-11-01）：球的直径只能有一个 owner。
//
// `44` 曾散在 5 处，每一处都是锚定计算（面板开在哪、浮层放得下吗、接缝吃多宽）。
// 副本不同步时行为测试全绿 —— 因为尺寸没变过 —— 所以门禁必须查「没有第二份定义」。
{
  const geometry = await readFile(path.join(root, 'src/client/ball-geometry.ts'), 'utf8')
  const configSrc = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  const indexSrc = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/export const BALL_SIZE = 44/.test(geometry),
    'F-018：球直径的唯一 owner 必须是 src/client/ball-geometry.ts')

  const anchorFiles = ['ball.ts', 'ball-visual.ts', 'panel.ts', 'quick.ts']
  for (const name of anchorFiles) {
    const raw = await readFile(path.join(root, 'src/client', name), 'utf8')
    // 先剥注释：这些文件在散文里会提到 44 与 BALL_SIZE，未剥会让门禁自己失败。
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    counted.equal(/(?:const|let|var)\s+BALL_SIZE\s*=/.test(code), false,
      `F-018：${name} 不得自己定义 BALL_SIZE`)
    counted.equal(/\b44\b/.test(code), false,
      `F-018：${name} 不得残留裸 44 —— 锚定常量必须走 BALL_SIZE`)
    counted.ok(/from '\.\/ball-geometry\.js'/.test(code),
      `F-018：${name} 必须从 ball-geometry 取球直径`)
  }

  // 循环依赖：ball.ts 已 import ball-visual.ts，反向引用会让常量在加载时为 undefined。
  const visualCode = (await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  counted.equal(/from '\.\/ball\.js'/.test(visualCode), false,
    'F-018：ball-visual.ts 不得 import ball.ts —— 会与 ball.ts 形成循环依赖')

  // 锚定必须真的用上尺寸，而不是只 import 了常量。参数化之后形参名是 `ballSize`
  // （默认值才接到 BALL_SIZE）—— 锁的是「锚定用了尺寸」而不是「用了哪个名字」。
  const panelCode = (await readFile(path.join(root, 'src/client/panel.ts'), 'utf8'))
  counted.ok(/viewportWidth - anchor\.x - ballSize/.test(panelCode),
    'F-018：面板右翻边必须用尺寸形参')
  counted.ok(/anchor\.y \+ ballSize \+ GAP/.test(panelCode),
    'F-018：面板下挂必须用尺寸形参')
  counted.ok(/ballSize: number = BALL_SIZE/.test(panelCode),
    'F-018：面板定位的尺寸形参必须默认 BALL_SIZE（旧调用不传参时不能塌成 undefined）')
  const quickCode = (await readFile(path.join(root, 'src/client/quick.ts'), 'utf8'))
  counted.ok(/viewportWidth - anchor\.x - ballSize/.test(quickCode),
    'F-018：快捷面板右翻边必须用尺寸形参')
  counted.ok(/anchor\.y \+ ballSize \+ QUICK_GAP/.test(quickCode),
    'F-018：快捷面板下挂必须用尺寸形参')
  counted.ok(/ballSize: number = BALL_SIZE/.test(quickCode),
    'F-018：快捷面板定位的尺寸形参必须默认 BALL_SIZE')
  // F-018 第二步：球大小必须是预设档位，且解析函数对未知值回落。
  counted.ok(/export const BALL_SIZES = \['small', 'medium', 'large'\]/.test(configSrc),
    'F-018：档位必须是 小/中/大 三档')
  // Host schema 必须有这个字段：漏了它，设置页会渲染出一个「写不进去」的控件
  // （form 认不得的 path 会被宿主静默拒绝），而界面看起来完全正常。
  counted.ok(/ballSize: z\.union\(\[z\.const\('small'\), z\.const\('medium'\), z\.const\('large'\)\]\)/.test(configSrc),
    'F-018：Host Config schema 必须声明 ballSize —— 否则设置页的控件写了也被静默丢弃')
  counted.ok(/ballSize: Volatile<BallSize \| undefined>/.test(configSrc),
    'F-018：TaskballConfig 接口必须有 ballSize，否则 Host 端读不到')
  counted.ok(/ballSize: createVolatile<BallSize \| undefined>\(DEFAULT_BALL_SIZE\)/.test(configSrc),
    'F-018：defaultConfig 必须给 ballSize 一个默认值（无 patch 配置时用）')
  counted.ok(/small: 36[\s\S]*?medium: 44[\s\S]*?large: 56/.test(
    await readFile(path.join(root, 'src/client/ball-geometry.ts'), 'utf8'),
  ), 'F-018：档位像素必须是 36 / 44 / 56')
  counted.ok(/export function ballSizePx/.test(
    await readFile(path.join(root, 'src/client/ball-geometry.ts'), 'utf8'),
  ), 'F-018：必须有 ballSizePx 解析函数（未知值回落，避免 NaN px 隐形球）')
  counted.ok(/ballSizePx\(typeof settings\.ballSize === 'string'/.test(indexSrc),
    'F-018：overlay 必须从设置解析出球尺寸并传下去')
  // 解析出来的尺寸必须真的到达四个绘制面。只解析不传 = 档位改了没反应，
  // 而这一步在界面上表现为「设置能改、球没变」，最难归因。
  for (const surface of ['TaskballBall', 'TaskballBubble', 'TaskballPanel', 'TaskballQuick']) {
    const call = indexSrc.slice(indexSrc.indexOf(`h(${surface}, {`))
    const body = call.slice(0, call.indexOf('})'))
    counted.ok(/ballSize[,:]/.test(body),
      `F-018：${surface} 必须收到 ballSize —— 否则它按错误直径锚定，球的档位一改就飘位`)
  }
  counted.ok(/const BALL_PX = BALL_SIZE/.test(
    (await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ''),
  ), 'F-018：扇区几何的 BALL_PX 必须由 BALL_SIZE 派生')

  // F-018 补齐：接缝必须随球尺寸缩放，否则大球上的接缝偏细、小球上的偏粗。
  // 判据是「角度由 ballPx 算出来」而不是「有个 seamDeg 函数」—— 后者在把常量
  // 塞回函数体里时依然成立（本仓库已多次踩过这种空转门禁）。
  const visualSrc = (await readFile(path.join(root, 'src/client/ball-visual.ts'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  counted.ok(/export function seamDeg\(ballPx: number/.test(visualSrc),
    'F-018：接缝角度必须按球直径计算（seamDeg(ballPx)），不能是固定常量')
  counted.ok(/const radius = Math\.max\(1, \(ballPx - FRAME_PX \* 2\) \/ 2\)/.test(visualSrc),
    'F-018：接缝角度的半径必须由传入的球直径算出')
  counted.ok(/seamHalfDeg\(span, ballPx\)/.test(visualSrc),
    'F-018：seamAngleOf 必须把球直径传给 seamHalfDeg（只定义参数不算）')
  counted.ok(/seamAngleOf\(slice, start, end, ballPx\)/.test(visualSrc),
    'F-018：sectorVariables 必须把球直径传进 seamAngleOf')
  const ballComponentSrc = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(/ballStyle\(slices, paletteHex, ballSize\)/.test(ballComponentSrc),
    'F-018：球必须把当前尺寸传给 ballStyle（静态渐变也按新尺寸算）')
  counted.ok(/animatedBallStyle\(slices, paletteHex, ballSize\)/.test(ballComponentSrc),
    'F-018：球必须把当前尺寸传给 animatedBallStyle')
}

// F-019（用户 2026-11-01：0–48px，0 = 关闭吸附）。
//
// 门禁的核心是 **0 必须真的关掉**，而不是「有个可调的距离」。两个具体陷阱：
// ① `nearest(targets, value, 0)` 在球正好落在线上时仍返回目标 —— 关闭必须由
//    `snapPosition` 自己判，不能指望 `nearest`；
// ② 客户端用 `?? SNAP_DISTANCE` 读这个值会把合法的 0 吞掉（`0 ?? 16` → 0 是对的，
//    但 `undefined ?? 16` 才是意图；写成 `||` 则 0 直接变 16）。
{
  const ballSource = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  counted.ok(/if \(!\(distance > 0\)\) \{\s*\n\s*return \{ position, attachment: \{\} \}/.test(ballSource),
    'F-019：snapPosition 必须自己判「距离 <= 0 = 关闭」，不能指望 nearest')
  counted.ok(/if \(!\(snapDistance > 0\)\) attachment\.current = \{\}/.test(ballSource),
    'F-019：关闭吸附时必须解除已有 attachment，否则已粘住的球会继续被钉回线上')
  counted.ok(/snapDistance\?: number \| undefined/.test(ballSource),
    'F-019：球必须接受 snapDistance prop')
  counted.ok(/snapPosition\(\s*\n?\s*settled,/.test(ballSource) && /snapDistance,\s*\n\s*\)/.test(ballSource),
    'F-019：松手吸附必须真的用 snapDistance（不能只定义 prop）')

  const configSource = await readFile(path.join(root, 'src/host/config.ts'), 'utf8')
  counted.ok(/export const SNAP_DISTANCE_MIN = 0/.test(configSource),
    'F-019：下限必须是 0 —— 那就是「关闭吸附」这个档位')
  counted.ok(/export const SNAP_DISTANCE_MAX = 48/.test(configSource),
    'F-019：上限 48（再大就等于球会自己飞到边上）')
  counted.ok(/snapDistance: Volatile<number \| undefined>/.test(configSource),
    'F-019：TaskballConfig 接口必须有 snapDistance')
  counted.ok(/snapDistance: createVolatile<number \| undefined>\(DEFAULT_SNAP_DISTANCE\)/.test(configSource),
    'F-019：defaultConfig 必须给它默认值')

  const indexSource = await readFile(path.join(root, 'src/client/index.ts'), 'utf8')
  counted.ok(/typeof settings\.snapDistance === 'number' \? settings\.snapDistance : SNAP_DISTANCE/.test(indexSource),
    'F-019：客户端只在 undefined 时回落 —— 直接把值交给 `??` 或 `||` 会让合法的 0 失效')
  counted.equal(/settings\.snapDistance \|\|/.test(indexSource), false,
    'F-019：不得用 `||` 读 snapDistance（0 会被吞成默认值）')
  counted.ok(/snapDistance,/.test(indexSource.slice(indexSource.indexOf('h(TaskballBall, {'))),
    'F-019：overlay 必须把 snapDistance 传给球')
}

// 拖拽 vs 点击的判定（2026-11-01 用户报障：拖动球后松手会打开面板）。
//
// 根因是判定用错了参照系 —— 拿「上一帧位置」比，而慢速拖动每帧只挪 1–2px，
// 永远不越过阈值，整段拖拽都被算成「没动」。所以这里锁两件事：判据必须相对
// 按下点，且阈值必须存在且非零（零会让球再也点不开）。
{
  const ballSrc = await readFile(path.join(root, 'src/client/ball.ts'), 'utf8')
  const drag = ballSrc.slice(ballSrc.indexOf('const onPointerDown'), ballSrc.indexOf('const onKeyDown'))
  counted.ok(drag.length > 500, '拖拽门禁切片必须非空（空切片会让后面的断言空转通过）')
  counted.ok(/const startX = event\.clientX/.test(drag),
    '拖拽判定必须记下按下点的 x —— 参照系必须是按下点，不是上一帧')
  counted.ok(/const startY = event\.clientY/.test(drag),
    '拖拽判定必须记下按下点的 y')
  counted.ok(/Math\.abs\(moveEvent\.clientX - startX\)/.test(drag),
    '必须与按下点比较 x')
  counted.ok(/Math\.abs\(moveEvent\.clientY - startY\)/.test(drag),
    '必须与按下点比较 y —— 漏掉 y 轴时纵向拖动会被当成点击')
  counted.equal(/const previous = latest\.current/.test(drag), false,
    '不得再用「上一帧位置」判拖拽：慢速拖动每帧位移都低于阈值，永远判不出拖动')
  counted.equal(/Math\.abs\(next\.x - previous\.x\)/.test(drag), false,
    '不得比较帧间位移（同上，这就是 2026-11-01 的 bug）')
  counted.ok(/export const DRAG_THRESHOLD_PX = [1-9]/.test(ballSrc),
    '拖拽阈值必须存在且非零 —— 归零会让手抖也算拖动，球再也点不开')
  counted.ok(/props\.onToggle\(\)/.test(drag),
    '「没拖动」的分支必须仍然打开面板（否则球失去主键功能）')
}


// A relative require would reach the loader's CJS shim with a path it cannot
// resolve, so it must fail here rather than in the user's browser.
const requires = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
const unexpected = requires.filter((specifier) => specifier !== 'react')
counted.deepEqual(unexpected, [], `lib/client.js must only require("react"); found: ${unexpected.join(', ')}`)

console.log(`Compatibility checks passed: DSH ${dshManifest.version}; ${gateCount} checks`)
