// D-026 新功能的回归测试：状态表示四模式、已处理区开关、勾选动效、收起反向旋转。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    innerHeight: 900,
    localStorage: { getItem: () => null, setItem() {} },
  }
  vm.runInNewContext(source, { window })
  return client
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
const sessionsState = {
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', title: '修复登录', displayTitle: '修复登录', blank: false, updatedAt: 1 },
    s2: { id: 's2', title: '写文档', displayTitle: '写文档', blank: false, updatedAt: 2 },
  },
}
const statusMap = new Map([
  ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s2', { running: false, pendingInteraction: undefined, completionUnread: true }],
])
const workspaceState = { items: [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['s1', 's2'] }] }
const hostState = {
  retentionMs: 30 * 60_000,
  sessions: {
    s2: { foldedAt: 10, foldedColor: 'green', lastTurnEnd: { kind: 'completed', at: 5 } },
  },
}

const client = loadClient()
const Panel = client.__test__.TaskballPanel

// 面板现在接收 overlay 已经算好的 view（单一 owner），所以测试也要先推导一次，
// 而不是让面板自己去 deriveView —— 那正是「归档会话在球上消失、面板里还在」的成因。
const { deriveView } = await import('../lib/model.mjs')

function makeView(archiveIds = []) {
  return deriveView(
    sessionsState.ids.map((id) => sessionsState.byId[id]),
    statusMap,
    workspaceState.items,
    hostState,
    20,
    { archivedSessionIds: new Set(archiveIds) },
  )
}

function renderPanel(overrides = {}) {
  return renderToStaticMarkup(React.createElement(Panel, {
    workspaces: workspaceState.items,
    view: makeView(),
    expanded: true,
    t,
    onToggleFolded() {},
    onOpenSession() {},
    onClose() {},
    ...overrides,
  }))
}

test('状态表示 rect：渲染 4px 矩形，无整行背景', () => {
  const markup = renderPanel({ statusMarker: 'rect' })
  assert.ok(markup.includes('data-taskball-swatch'))
  assert.ok(markup.includes('data-marker="rect"'))
  assert.ok(!markup.includes('padding-left:2em'), '矩形模式不应有整行缩进')
  // 只看 swatch 自己那一段 style：面板里其他元素（关闭按钮等）也有圆角，
  // 整篇搜 `border-radius:50%` 会把它们算进来（门禁写太松的典型形态）。
  const swatch = markup.slice(markup.indexOf('data-taskball-swatch'), markup.indexOf('data-taskball-swatch') + 260)
  assert.equal(swatch.includes('border-radius:50%'), false, '矩形不得有 50% 圆角')
  assert.ok(swatch.includes('width:4px'), '矩形宽度必须是 4px')
})

test('状态表示 dot：渲染 8px 圆点', () => {
  const markup = renderPanel({ statusMarker: 'dot' })
  assert.ok(markup.includes('data-marker="dot"'))
  assert.ok(markup.includes('data-taskball-swatch'))
  assert.ok(markup.includes('border-radius:50%'), '圆点必须有 50% 圆角')
  assert.ok(markup.includes('width:8px'), '圆点宽度必须是 8px')
})

// 2026-11-03（用户：「只保留色条和圆点，其他的不要了」）：四种整行模式已删除。
// 这条测试是防复活闸门 —— 只要任何一个回来，就会有一条渲染分支重新出现，
// 而它的存在会让「只保留两个」这条决定静默失效。
//
// 注意 `data-marker` 会原样回显传入值（它是调试属性，不是渲染分支的开关），
// 所以判据不能看这个属性，要看**实际渲染出的形状**：删除的四种模式必须
// 退化成色块（有 swatch、无整行缩进、无整行填色）。
test('整行着色的四种模式已删除，不得复活', () => {
  for (const retired of ['row-solid', 'row-tint', 'row-box', 'row-tint-outline']) {
    const markup = renderPanel({ statusMarker: retired })
    assert.ok(markup.includes('data-taskball-swatch'),
      `${retired} 已删除，必须退化成色块模式（渲染色块）`)
    assert.equal(markup.includes('padding-left:2em'), false,
      `${retired} 不得再产生整行缩进`)
    // 整行填色会把状态色铺到 row 容器上。只看 row 容器自己的 style 段：
    // 往后 400 字符会把 swatch 的 background 也算进来（判据写太松的典型形态）。
    const rowStart = markup.indexOf('data-taskball-row')
    const rowTag = markup.slice(rowStart, markup.indexOf('>', rowStart) + 1)
    assert.equal(/background:#[0-9a-f]{6}/.test(rowTag), false,
      `${retired} 不得再给整行铺状态色`)
  }
})

// F-002（D-039）/ D-075：面板独立不透明度 + 磨砂。
//
// D-039 原本要求「默认与以前完全一样的不透明外观」，理由是加新字段不该改变老用户
// 的面板。D-075（用户 2026-11-02）**有意推翻**了那个默认：新默认是「磨砂 + 30%」，
// 因为 30% 能让宿主底色透过模糊显示出来（有皮肤时更好看），而 100% 会让模糊
// 完全看不见 —— 那正是 D-039 当初要修的那个缺陷。
//
// 保留的约束是「两个默认必须一致」：设置值、overlay 兜底、panelAlpha 兜底三处
// 都指向同一个外观，否则首次渲染会闪一帧实色面板。
test('D-075：默认是磨砂 + 30% 不透明度，且三处兜底一致', () => {
  const plain = renderPanel({})
  // 新默认：磨砂开 → 有 backdrop-filter、有 color-mix（alpha 30 < 100）
  assert.ok(plain.includes('data-frosted="true"'), '默认必须带 data-frosted（磨砂默认开）')
  assert.ok(plain.includes('backdrop-filter:var(--dsw-menu-backdrop-filter'),
    '默认必须用宿主菜单材质 token 做模糊')
  assert.ok(plain.includes('color-mix'), '默认 30% 必须走 color-mix 半透明层')
  assert.ok(plain.includes('30%'), '默认百分比必须是 30%')

  // 不透明度 100 仍然可达，且必须退回纯 token（老外观保留给愿意调的人）。
  // 注意：必须同时关掉磨砂 —— 磨砂会把 100 压到 FROSTED_ALPHA_CAP(72)，那是
  // D-039 的既有行为（100% 不透明的背景会把模糊完全挡住）。
  const solid = renderPanel({ panelOpacity: 100, panelFrosted: false })
  assert.ok(solid.includes('--dsw-alias-bg-layer-2'), '100 时必须用宿主 token')
  assert.equal(solid.includes('color-mix'), false, '100 + 无磨砂时不得引入 color-mix 层')

  // 磨砂 + 100 会被压到 72，所以仍然有 color-mix —— 这不是回归，是 D-039 的规则
  const capped = renderPanel({ panelOpacity: 100 })
  assert.ok(capped.includes('color-mix'), '磨砂下 100 必须被压到 72，仍然半透明')
  assert.ok(capped.includes('72%'), '磨砂上限必须是 72%')

  // 关掉磨砂时不得有模糊
  const noFrost = renderPanel({ panelFrosted: false })
  assert.equal(noFrost.includes('backdrop-filter'), false, '未开磨砂时不得有 backdrop-filter')
  assert.equal(noFrost.includes('data-frosted'), false, '未开磨砂时不得带 data-frosted')

  const dim = renderPanel({ panelOpacity: 60 })
  assert.ok(dim.includes('color-mix'), '低于 100 时背景必须变半透明')
  assert.ok(dim.includes('60%'), '百分比必须原样进入 color-mix')
})

// F-012（D-040）：行消失时面板高度必须连续收缩，不能瞬间跳。
// 实现是 grid 的 1fr→0fr 轨道，不需要测量 —— 测量 + 重渲染在本宿主里会互相触发（F10）。
test('F-012：行槽位用 grid-template-rows 收缩，且裁剪与时长对齐离场动画', () => {
  const markup = renderPanel({})
  assert.ok(markup.includes('data-taskball-slot'), '每行必须包在可收缩的槽位里')
  assert.ok(markup.includes('grid-template-rows:1fr'), '静止态轨道必须是 1fr')
  assert.ok(markup.includes('overflow:hidden'), '收缩时必须裁剪，否则行会画到邻居上')

  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  assert.ok(/gridTemplateRows:\s*isLeaving \? '0fr' : '1fr'/.test(source), '离场时轨道必须落到 0fr')
  assert.equal(/getBoundingClientRect\(\)[\s\S]{0,80}setState/.test(source), false, '不得靠测量行高来补间')

  const css = readFileSync(new URL('../src/client/style.ts', import.meta.url), 'utf8')
  assert.ok(
    /\[data-taskball-slot\][\s\S]{0,120}transition: grid-template-rows 220ms/.test(css),
    '收缩时长必须与 slide-out 的 220ms 一致',
  )
  assert.ok(
    /\[data-taskball-slot\]\[data-anim="slide-down"\][\s\S]{0,140}transition-duration: 280ms/.test(css),
    'slide-down 必须跟随 280ms',
  )
  assert.ok(
    /prefers-reduced-motion[\s\S]{0,200}\[data-taskball-slot\][\s\S]{0,60}transition: none/.test(css),
    'reduced-motion 下不得补间',
  )
})

// F-006（用户 2026-10-28）：多条标题行之间加 0.5px 空隙。间隙只能落在行与行之间：
// 分组标题在行容器之外，所以「标题 → 第一行」不留缝；分组之间已有面板的 6px。
test('F-006：行与行之间是 0.5px 间隙，分组标题在间隙容器之外', () => {
  const markup = renderPanel({ statusMarker: 'row-tint' })
  assert.ok(markup.includes('data-taskball-rows'), '行必须包在独立的列容器里')
  assert.ok(markup.includes('row-gap:0.5px'), '行间间隙必须是 0.5px')

  const section = markup.slice(markup.indexOf('<section'))
  const labelAt = section.indexOf('项目一')
  const rowsAt = section.indexOf('data-taskball-rows')
  assert.ok(labelAt >= 0 && rowsAt > labelAt, '分组标题必须出现在行容器之前')
  assert.ok(
    section.slice(labelAt, rowsAt).includes('</div>'),
    '分组标题的 div 必须在行容器之前闭合 —— 否则标题与第一行之间也会多出 0.5px',
  )
  // 已处理区里的行同样生效（同一个 renderRows）
  assert.ok(markup.includes('data-taskball-rows="folded"'), '已处理区的行也必须包在同一个间隙容器里')
})

// F-004（用户 2026-10-28 / D-038）：红色二次确认从「行下方告警框」改成
// 「整条左滑 + 原位两个块」。两块是覆盖层，行高不变；确认前不得折叠。
test('F-004：红色确认是原位两块，不是行下方的告警框', () => {
  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  // The confirm surfaces live in their own module (refactor 2026-11-01), so the
  // component itself is asserted THERE. `panel.ts` is still the owner of what
  // makes them "in place": the row's `data-confirming` and the absolute overlay.
  const confirm = readFileSync(new URL('../src/client/panel-confirm.ts', import.meta.url), 'utf8')
  assert.equal(/function ConfirmRed\b/.test(source), false, '旧告警框组件必须删除')
  assert.equal(/function ConfirmRed\b/.test(confirm), false, '旧告警框组件必须删除')
  assert.ok(/function RedConfirmBar/.test(confirm), '必须用原位两块组件')
  assert.ok(source.includes("'data-confirming'"), '行必须带 data-confirming 让位')
  assert.ok(confirm.includes('position: \'absolute\''), '两块必须是原位覆盖层，不能把行挤下去')

  const bar = confirm.slice(confirm.indexOf('function RedConfirmBar'))
  assert.equal((bar.match(/type: 'button'/g) ?? []).length, 2, '确认条必须恰好两个按钮')
  assert.equal(/confirmRed\.open/.test(source + confirm), false, '「查看会话」按用户裁定删除')

  // 确认前不得折叠：确认按钮才调 onToggleFolded，左滑只是绘制
  const confirmAt = source.indexOf('onConfirm: () => {')
  const block = source.slice(confirmAt, confirmAt + 500)
  assert.ok(/onToggleFolded\(entry\.id, entry\.color, true\)/.test(block), '确认后才折叠')
  assert.equal(/animateOut/.test(block), false, '确认后的折叠不得依赖离场动画（D-034）')
  assert.ok(/addEventListener\('keydown'/.test(source), 'Esc 取消')
})

// WCAG 2.2 AA「Target Size (Minimum)」要求指针目标 ≥ 24×24 CSS px。
// 原生 checkbox 只有约 13px，所以每条模式的实际可点区域都必须撑到 24。
// 2026-11-03：只剩 rect / dot 两种模式，两者的勾选框形状相同，都不再有
// row-box 那种「13px 可见方块 + label 撑点击区」的例外形态。
test('勾选框的指针目标不得小于 24×24 CSS px（WCAG 2.2 AA）', () => {
  for (const marker of ['rect', 'dot']) {
    const markup = renderPanel({ statusMarker: marker })
    const check = markup.match(/<input[^>]*data-taskball-check[^>]*>/)?.[0] ?? ''
    assert.ok(check !== '', `${marker} 必须有勾选框`)
    assert.ok(/height:24px/.test(check), `${marker} 的勾选框高度必须 ≥ 24px`)
    assert.ok(/width:24px/.test(check), `${marker} 的勾选框宽度必须 ≥ 24px`)
  }
})

// F8（用户 2026-10-28）：面板左上角不再显示「任务状态」四个字，
// 只留中间的四个颜色小球。标题仍作为 dialog 的 aria-label 保留，
// 所以移除可见文字不损失可访问性。
test('面板头部不再显示标题文字，只保留四个颜色小球（F8）', () => {
  const markup = renderPanel({})
  assert.ok(!markup.includes('<strong'), '标题 <strong> 必须移除')
  assert.ok(markup.includes('data-taskball-counts'), '必须渲染颜色统计容器')
  const dots = markup.match(/data-taskball-counts[\s\S]*?<\/div>/)
  assert.ok(dots !== null, '统计容器必须闭合')
  assert.equal((dots[0].match(/corner-shape:round/g) ?? []).length, 4, '必须正好四个小球')
  // 可访问性：dialog 的名称仍来自 panel.title
  assert.ok(markup.includes('aria-label="panel.title"'), 'dialog 必须保留 aria-label 作为无障碍名称')
})

// 用户 2026-10-29：四个小圆改为在面板首行**居中**排列。
// 必须相对「面板」居中，而不是在关闭按钮让出的剩余空间里居中 ——
// 右侧按钮宽度与左侧空白不等，用 space-between 居中的结果是偏左。
test('面板首行四个小圆相对面板居中，关闭按钮仍靠右（用户 2026-10-29）', () => {
  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  const header = source.slice(source.indexOf("'data-taskball-counts'"), source.indexOf("t('panel.close')"))

  assert.ok(header.includes("left: '50%'"), '小圆容器必须定位到面板水平中线')
  assert.ok(header.includes("top: '50%'"), '小圆容器必须垂直居中')
  assert.ok(/transform:\s*'translate\(-50%, -50%\)'/.test(header), '必须用 translate(-50%,-50%) 让自身中心对齐中线')
  assert.ok(header.includes("position: 'absolute'"), '绝对定位才能不受右侧按钮宽度影响')
  assert.equal(
    /justifyContent:\s*'space-between'/.test(source.slice(source.indexOf("'data-taskball-counts'") - 400, source.indexOf("t('panel.close')"))),
    false,
    '不得再用 space-between 假装居中（右侧按钮会让它偏左）',
  )

  const markup = renderPanel({})
  const closeButton = markup.slice(markup.indexOf('aria-label="panel.close"'))
  assert.ok(/margin-left:auto/.test(closeButton), '关闭按钮必须靠右，不能跟着小圆跑到中间')
})

test('已处理区开关：默认显示，关闭后整段不渲染', () => {
  const shown = renderPanel({ showFoldedSection: true })
  assert.ok(shown.includes('panel.folded'), '默认应显示已处理区')

  const hidden = renderPanel({ showFoldedSection: false })
  assert.ok(!hidden.includes('panel.folded'), '关闭后不应渲染已处理区')
  // 折叠状态本身不受影响：Host 记录仍在
  assert.equal(hostState.sessions.s2.foldedAt, 10)
})

// 真机实测（2026-10-28）：球上归档会话已消失，面板里却还在 ——
// 因为面板自己又跑了一次 deriveView 且没传归档集合。
// 现在面板接收 overlay 的 view，这条锁住「面板不得自己重新推导」。
test('归档会话必须同时从面板消失（面板不得自行 re-derive）', () => {
  const normal = renderPanel({ view: makeView() })
  assert.ok(normal.includes('data-taskball-row'), '未归档时应有行')

  const archivedAll = renderPanel({ view: makeView(['s1', 's2']) })
  assert.ok(!archivedAll.includes('data-taskball-row'), '全部归档后不应渲染任何行')
})

test('勾选动效：两个模式各自带 data-anim，且时长与 CSS 一致', () => {
  const slideOut = renderPanel({ foldAnimation: 'slide-out' })
  assert.ok(slideOut.includes('data-anim="slide-out"'))

  const slideDown = renderPanel({ foldAnimation: 'slide-down' })
  assert.ok(slideDown.includes('data-anim="slide-down"'))

  assert.equal(client.__test__.exitDurationMs('slide-out'), 220)
  assert.equal(client.__test__.exitDurationMs('slide-down'), 280)

  // CSS 里的 keyframe 时长必须与之匹配，否则行会被提前截断
  const css = readFileSync(new URL('../src/client/style.ts', import.meta.url), 'utf8')
  assert.ok(css.includes('taskball-row-out 220ms'), 'slide-out keyframe 时长应为 220ms')
  assert.ok(css.includes('taskball-row-down 280ms'), 'slide-down keyframe 时长应为 280ms')
})

test('行初始状态不得是 data-leaving=true（否则一渲染就消失）', () => {
  const markup = renderPanel({})
  assert.ok(markup.includes('data-leaving="false"'))
  assert.ok(!markup.includes('data-leaving="true"'))
})

// D-033：加载中与「确实没有任务」是两件事，面板必须给出不同文案。
// 页面刷新后客户端要几秒才拿到会话列表，这段时间说「暂无任务状态」是假信息。
test('D-033：面板加载中显示 loading 而不是 empty', () => {
  const emptyView = deriveView([], new Map(), [], { retentionMs: 30 * 60_000, sessions: {} }, 20)
  const props = {
    workspaces: [],
    view: emptyView,
    expanded: true,
    t,
    onClose: () => {},
    onOpenSession: () => {},
    onToggleFolded: () => {},
  }
  const loading = renderToStaticMarkup(React.createElement(Panel, { ...props, loading: true }))
  assert.ok(loading.includes('panel.loading'))
  assert.equal(loading.includes('panel.empty'), false)

  const ready = renderToStaticMarkup(React.createElement(Panel, { ...props, loading: false }))
  assert.ok(ready.includes('panel.empty'))
  assert.equal(ready.includes('panel.loading'), false)
})

// D-034（推翻 BUG1 的补丁式修法）：折叠的语义状态来自 props.view.folded，
// 由 overlay 的本地覆盖在点击瞬间给出；面板的计时器只决定「这一行在 220/280ms
// 里画在哪个区域」，不得参与「算不算已处理」。规范原文：不要依赖
// animationend / transitionend 保证必需的状态正确性，直接设最终语义状态。
test('折叠语义不依赖动画与轮询，且不存在等待 Host 确认的抑制态（D-034）', () => {
  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  assert.equal(/awaitingFold/.test(source), false, '删除 awaitingFold —— 语义不得等待 Host 轮询')
  assert.equal(/AWAIT_CONFIRM_TIMEOUT_MS/.test(source), false, '删除补丁式安全网；失败自愈已上移到覆盖层')
  assert.ok(/visualFolded/.test(source), '离场行需要独立于语义的「绘制分区」投影')
  assert.ok(
    /!leaving\.has\(entry\.id\)/.test(source),
    '离场行只允许画在一个区域，否则会同时出现在主列表与已处理区',
  )
  assert.ok(
    /occupiesSector\(entry\.color, visualFolded, entry\.id\)/.test(source),
    'active 仍必须复用 occupiesSector（D-028）',
  )

  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(/overriddenFolds\(/.test(index), 'overlay 必须把本地折叠覆盖合进 folded')
  assert.ok(/view: effectiveView/.test(index), '面板必须收到合并后的 view')
  assert.ok(/folded: effectiveFolded/.test(index), '球必须收到同一份 folded，否则两处口径分叉')
  assert.ok(/pruneFoldOverrides\(/.test(index), '必须有覆盖回收（Host 确认 / 状态变化 / 超时）')
})

// F-008（用户 2026-10-30 定方案 b）：Shift + 勾红 = 批量折叠全部红色。
// 它绕不开 D-006 / D-018 的护栏 —— 护栏的形态从「逐条确认条」变成「一个列出
// 全部将被折叠会话的弹窗」，确认前一条都不折叠。
test('F-008：Shift+勾红弹出批量确认弹窗，列出全部红色会话标题', () => {
  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  // The dialog itself lives in its own module (refactor 2026-11-01); the trigger
  // path and the commit behaviour stay in `panel.ts`, so both files are read.
  const confirmSource = readFileSync(new URL('../src/client/panel-confirm.ts', import.meta.url), 'utf8')

  // 触发路径：读 click 的 shiftKey（change 事件没有修饰键）
  assert.ok(/function RedBulkConfirmDialog/.test(confirmSource), '必须有批量确认弹窗组件')
  assert.ok(/onClick: \(event\) => \{ shiftHeldRef\.current = event\.shiftKey === true \}/.test(source),
    '必须在 click 上记录 shiftKey —— change 事件不带修饰键')
  assert.ok(/requestToggle\(entry, shiftHeldRef\.current\)/.test(source),
    'change 必须消费 click 记录的修饰键')
  assert.ok(/setBulkRedPending\(/.test(source), 'Shift+勾红必须打开批量弹窗')

  // 弹窗结构：标题 + 说明 + 会话清单 + 恰好两个选择块
  // Slice to the END of this component: the next top-level `export function`
  // in the same file is `RedConfirmBar`, whose own two buttons must not count.
  const dialogStart = confirmSource.indexOf('function RedBulkConfirmDialog')
  const dialogEnd = confirmSource.indexOf('export function RedConfirmBar')
  const dialog = confirmSource.slice(dialogStart, dialogEnd)
  assert.equal((dialog.match(/type: 'button'/g) ?? []).length, 2, '弹窗必须恰好两个选择块')
  assert.ok(/data-taskball-bulk-list/.test(dialog), '弹窗必须列出会话（不是只给一个数量）')
  assert.ok(/entry\.title/.test(dialog), '清单里的每一行必须是会话标题')
  assert.ok(/panel\.bulkRed\.title/.test(dialog) && /panel\.bulkRed\.body/.test(dialog), '标题与后果说明必须都有')
  assert.ok(/palette\.ink\.red/.test(dialog), '确认块用调色板墨色，不用写死白字（D-029 的对比度规则）')
  assert.ok(/cancelRef\.current\?\.focus\(\)/.test(dialog), '焦点默认落在「取消」，误触不得隐藏失败')

  // Esc 取消，且不折叠任何一条
  assert.ok(/bulkRedPending\.length === 0/.test(source), 'Esc 监听只在弹窗打开时挂载')
  assert.ok(/setBulkRedPending\(\[\]\)/.test(source), 'Esc 取消必须清空待折叠集合')

  // 确认后的行为：一次性折叠 + 一起播离场动画（用户 2026-10-30 明确要求）
  const confirm = source.slice(source.indexOf('const confirmBulkRed'), source.indexOf('const marker ='))
  assert.ok(/animateOut\(ids, exitDurationMs\(props\.foldAnimation\)\)/.test(confirm),
    '红色行必须一起播离场动画')
  assert.ok(/onBulkFold\?\.\(ids, true\)/.test(confirm),
    '批量折叠必须走一次 onBulkFold，不要 for 循环逐条写 Host')
  assert.equal(/onToggleFolded/.test(confirm), false, '批量路径不得退化成逐条 onToggleFolded')
})


// D-071（用户 2026-11-02）：「快捷面板中的『一键勾选绿色/红色』这几个都可以不要了，
// shift 组合键可以满足了」。三个批量按钮是 Shift 路径的第二个入口，删掉它们
// 不减少任何能力 —— 所以这条测试同时锁两件事：按钮真的没了，Shift 路径还在。
test('D-071：面板首行的三个批量按钮已删除，Shift 路径仍在', () => {
  const source = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8')
  const locale = readFileSync(new URL('../src/client/locale.ts', import.meta.url), 'utf8')

  // 按钮与它的工厂函数都不得复活
  assert.equal(/bulkButton/.test(source), false, '批量按钮必须已删除')
  assert.equal(/bulk\(colors\)/.test(source), false, '批量按钮的点击处理必须已删除')

  // 随按钮一起删掉的文案不得残留（红/绿/双色的三个标题）
  for (const key of ['panel.bulkGreen', 'panel.bulkBoth']) {
    assert.equal(locale.includes(key), false, `已删除按钮的文案 ${key} 不得残留`)
  }

  // 反向：Shift 两条批量路径必须都还在 —— 删按钮不等于删能力
  assert.ok(/shiftKey && entry\.color === 'green'/.test(source),
    '绿色 Shift 批量路径必须保留')
  assert.ok(/shiftKey && needsRedConfirm/.test(source),
    '红色 Shift 批量确认路径必须保留（D-006 护栏）')
})

test('D-071：面板首行不再渲染批量按钮，但四个状态小圆仍在', () => {
  const markup = renderPanel({})
  assert.equal(markup.includes('data-taskball-bulk'), false, '不得渲染任何批量按钮')
  assert.ok(markup.includes('data-taskball-counts'), '首行的状态小圆必须保留')
  const circles = markup.match(/title="(red|yellow|blue|green):/g) ?? []
  assert.equal(circles.length, 4, '四个状态小圆必须都在')
})

// F-023（2026-11-03）：第三方皮肤会用 `body :is([role="dialog"]) { background: … !important }`
// 改写本插件浮层的背景（open-sea-skin 1.2.6 实际如此）。样式表的 !important 压过
// 普通内联声明，所以内联 background 防不住；修法是让值走自定义属性，由我们自己的
// !important 规则消费。
//
// 这组断言锁「两半都在」：只锁样式表或只锁内联属性，另一半点被删时会静默通过。
test('F-023：面板把背景值同时写进内联与自定义属性（皮肤防护的两半）', () => {
  const markup = renderPanel({})
  // 半 1：自定义属性存在（样式表那条 !important 规则靠它取值）
  assert.ok(markup.includes('--taskball-surface-fill'),
    '面板必须设置 --taskball-surface-fill，否则皮肤防护规则读到 undefined')
  // 半 2：普通内联 background 仍在（没有皮肤时它是唯一来源）
  assert.ok(/background:color-mix|background:var\(--dsw-alias-bg-layer-2/.test(markup.replace(/\s+/g, '')),
    '面板必须保留普通内联 background 作为基线')
  // 反向：不得把 !important 塞进内联值 —— React 用 style[name]=value 赋值，
  // 带 !important 会被浏览器静默丢弃，看起来修好了其实没有（2026-11-03 实测）。
  assert.equal(/background:[^;"]*!important/.test(markup), false,
    '不得用内联 background 带 !important（React 会静默丢弃）')
})

test('F-023：样式表里那条防护规则必须带 !important 且消费正确的变量', () => {
  const css = readFileSync(new URL('../src/client/style.ts', import.meta.url), 'utf8')
  assert.ok(/html body \[data-taskball-panel\]\[data-open\],\s*\n\s*html body \[data-taskball-quick\]\[role="dialog"\]\s*\{\s*\n\s*background: var\(--taskball-surface-fill\) !important;/.test(css),
    '面板与快捷面板必须由带 !important 的规则消费 --taskball-surface-fill')
  assert.ok(/html body \[data-taskball-bulk-confirm\]\[aria-modal="true"\]\s*\{\s*\n\s*background: var\(--taskball-backdrop-fill\) !important;/.test(css),
    '批量确认遮罩必须由带 !important 的规则消费 --taskball-backdrop-fill')
  // 遮罩是「压暗」不是「卡片」：它必须比皮肤那条约 97% 不透明的规则更透，
  // 否则面板背后就看不见了 —— 这是它和另外两处用不同变量的原因。
  assert.ok(/--taskball-backdrop-fill/.test(css) && /--taskball-surface-fill/.test(css),
    '两个变量必须分开：遮罩与卡片的取值语义不同')
  // 第三轮（0.8.9）：皮肤 1.2.7 的 :not(#id) 把特异性抬进 ID 列，算特异性追不上。
  // @layer 让分层 !important 无条件压过未分层声明，与特异性无关 —— 这才是稳定解。
  assert.ok(/@layer\s+taskball-defense\s*\{/.test(css),
    '防护规则必须包在 @layer taskball-defense 里，否则皮肤抬高特异性就又赢了')
})
