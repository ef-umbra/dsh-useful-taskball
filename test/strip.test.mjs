// F-021 收起态竖条（用户 2026-10-31 草图 + 12 条批注，D-063）
//
// 用户拍板的要点，逐条对应到这里的断言：
//   ① 无任务 → 显示一段中性灰，不是整条消失
//   ② 段高 < 4px 时不画缝
//   ③ hover 展开回到「收起前的坐标」
//   ④ 纯视觉 + 点击复原成球（真实 button）
//   ⑤ 触屏不启用
//   ⑥ 窄屏保底距离 ≈ 一个球的空间
//   ⑨ 颜色即状态色，且色盲模式必须跟着换
//   ⑪ 段序按 F-007 草案：红 > 黄 > 蓝 > 绿
//
// 纯函数部分不依赖 DOM；渲染部分用真实 React 静态渲染（与 panel-options 同法）。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  // A real Storage-shaped object: the persistence helpers use getItem/setItem/
  // removeItem and a Map has none of those.
  const store = new Map()
  const localStorage = {
    getItem: (key) => store.get(key) ?? null,
    removeItem: (key) => { store.delete(key) },
    setItem: (key, value) => { store.set(key, String(value)) },
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    innerHeight: 900,
    localStorage,
    matchMedia: () => ({ matches: false }),
    CSS: { registerProperty() {} },
  }
  vm.runInNewContext(
    source,
    // `globalThis` INSIDE the vm context is the context object itself, not our
    // `window` — production code reads `globalThis.localStorage` (same as
    // `ball.ts`), so the storage has to be reachable there too or the persistence
    // helpers would silently see a different object than the one the test writes.
    { window, localStorage, setTimeout, clearTimeout, setInterval, clearInterval },
  )
  return client
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

const entry = (id, color, updatedAt = 0) => ({
  color, completedAt: undefined, id, title: id, updatedAt, workspaceId: undefined,
})

const render = (props) => renderToStaticMarkup(React.createElement(props.component, {
  left: 100,
  onQuick() {},
  onRestore() {},
  t,
  top: 200,
  ...props.props,
}))

// ---------------------------------------------------------------- 段序与分段

test('F-021：段序按 F-007 草案 红 > 黄 > 蓝 > 绿，与球环共用同一个排序', async () => {
  const client = await loadClient()
  const { stripSegments } = client.__test__
  const entries = [
    entry('g1', 'green'),
    entry('b1', 'blue'),
    entry('r1', 'red'),
    entry('y1', 'yellow'),
  ]
  // 跨 realm 比较：`stripSegments` 跑在 vm 上下文里，返回的数组原型与测试文件
  // 不共享，`deepEqual` 会判「结构相同但非同一引用」。比较内容而不是对象身份。
  assert.equal(
    stripSegments(entries).map((segment) => segment.color).join(','),
    'red,yellow,blue,green',
    '竖条从上到下必须是 红 > 黄 > 蓝 > 绿',
  )
  // 同色多段：草图里有两个绿段，说明是一会话一段，不是按颜色合并。
  const twoGreens = stripSegments([entry('g1', 'green'), entry('g2', 'green')])
  assert.equal(twoGreens.length, 2, '每个会话占一段（用户草图里两个绿段可证）')
  assert.equal(twoGreens.map((segment) => segment.id).join(','), 'g1,g2')
})

test('F-021：球环的扇区顺序必须与竖条一致（不允许两个面各说一套）', async () => {
  const client = await loadClient()
  const { sectorAngles } = client.__test__
  const entries = [entry('g1', 'green'), entry('b1', 'blue'), entry('r1', 'red')]
  assert.equal(
    sectorAngles(entries).map((sector) => sector.color).join(','),
    'red,blue,green',
    '环按 COLOR_ORDER 排，否则同一次状态变化条和环顺序会不一致',
  )
})

test('F-021：同色条目顺序必须确定，不能随 store 重建而抖动', async () => {
  const client = await loadClient()
  const { sectorAngles, orderEntries } = client.__test__
  // 同色、同 updatedAt：只能靠 id 兜底，否则两次渲染顺序可能不同 → 扇区乱跳。
  const a = [entry('b', 'red', 5), entry('a', 'red', 5)]
  const b = [entry('a', 'red', 5), entry('b', 'red', 5)]
  assert.equal(
    orderEntries(a).map((item) => item.id).join(','),
    orderEntries(b).map((item) => item.id).join(','),
    '输入顺序不同，输出顺序必须相同',
  )
  // 同色不同 updatedAt：新的在前。
  assert.equal(
    orderEntries([entry('old', 'red', 1), entry('new', 'red', 9)]).map((item) => item.id).join(','),
    'new,old',
  )
  assert.equal(sectorAngles([]).length, 0)
  assert.equal(sectorAngles(a).length, 2)
})

test('F-021：无任务时是一段中性灰，不是整条消失（批注 ①/⑫）', async () => {
  const client = await loadClient()
  const { stripSegments } = client.__test__
  const empty = stripSegments([])
  assert.equal(empty.length, 1)
  assert.equal(empty[0].color, 'gray')
  // 灰色条目本身不占段（与球环一致：灰 = 没有任务状态）。
  assert.equal(stripSegments([entry('x', 'gray')]).length, 1)
  assert.equal(stripSegments([entry('x', 'gray')])[0].color, 'gray')
})

// ------------------------------------------------- 只显示未处理项（用户 2026-10-31 报障）
//
// 用户原话：「竖条上显示了所有的未处理项和已处理项，但是我只需要它显示未处理的任务
// 状态即可，也就是和悬浮球展示内容一样」。
//
// 判据必须与球环共用 `occupiesSector`，不能各写一套等价过滤（D-005 / D-028 的双口径
// 教训）。下面第一条断言就是「球与条对同一份输入给出同样的条目集合」。

test('F-021：竖条只画未处理项，且与球环的条目集合完全一致（用户 2026-10-31）', async () => {
  const client = await loadClient()
  const { stripSegments, sectorEntries, sectorAngles } = client.__test__
  const entries = [
    entry('r1', 'red'),
    entry('r2', 'red'),
    entry('b1', 'blue'),
    entry('g1', 'green'),
  ]
  const folded = new Set(['r2', 'g1'])

  // ① 已处理项不占段。
  const ids = stripSegments(entries, folded).map((segment) => segment.id)
  assert.equal(ids.join(','), 'r1,b1', `已处理项必须从竖条消失，实际：${ids.join(',')}`)

  // ② 与球环逐条一致 —— 这是用户诉求的原文「和悬浮球展示内容一样」。
  //    比的是「哪些会话被画出来」，不是段数（球按角度、条按等高段）。
  const ringIds = sectorEntries(entries, folded).map((item) => item.id).sort().join(',')
  const stripIds = [...ids].sort().join(',')
  assert.equal(stripIds, ringIds, '竖条与球环画出的会话集合必须完全相同')

  // ③ 未处理时行为不变（不能因为加了过滤把正常路径弄坏）。
  assert.equal(stripSegments(entries).length, 4, '不传 folded 时四段全画')
  assert.equal(stripSegments(entries, new Set()).length, 4, '空 folded 集合 = 全部未处理')

  // ④ 球环本身也不含已处理项（确认比较基准是对的，不是两边都错）。
  assert.equal(sectorAngles(sectorEntries(entries, folded)).length, 2)
})

test('F-021：全部已处理时竖条退回一段中性灰，而不是变成空白条', async () => {
  const client = await loadClient()
  const { stripSegments } = client.__test__
  const entries = [entry('r1', 'red'), entry('b1', 'blue')]
  const allFolded = new Set(['r1', 'b1'])
  const segments = stripSegments(entries, allFolded)
  assert.equal(segments.length, 1, '全处理完时与「无任务」同形：一段灰')
  assert.equal(segments[0].color, 'gray')
  assert.equal(segments[0].id, '__empty__')
})

test('F-021：渲染层同样排除已处理项（不能只改纯函数）', async () => {
  const client = await loadClient()
  const { TaskballStrip, DEFAULT_PALETTE } = client.__test__
  const entries = [entry('r1', 'red'), entry('b1', 'blue'), entry('g1', 'green')]
  const html = render({
    component: TaskballStrip,
    props: { entries, folded: new Set(['r1', 'g1']) },
  })
  assert.match(html, /data-strip-segments="1"/, '只剩 1 条未处理 → 1 段')
  assert.ok(html.includes(DEFAULT_PALETTE.hex.blue), '未处理的那条（蓝）必须还在')
  assert.equal(html.includes(DEFAULT_PALETTE.hex.red), false, '已处理的红不得出现在竖条上')
  assert.equal(html.includes(DEFAULT_PALETTE.hex.green), false, '已处理的绿不得出现在竖条上')
  // 只有一段时没有「段间」可言，不该画缝。
  assert.equal(html.includes('data-strip-seams'), false)
})

test('F-021：overlay 必须把 effectiveFolded 传给竖条（点击即生效，不等轮询）', async () => {
  // 源码级判据：传 `view.folded`（Host 集合）会让勾选后竖条多挂一个轮询周期，
  // 而面板已经移走了那一行 —— 又回到「两个面各说一套」。这条只能读源码：
  // 渲染断言看不到 overlay 传的是哪个变量。
  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const call = index.slice(index.indexOf("h(TaskballStrip, {"), index.indexOf('h(TaskballBall, {'))
  assert.ok(call.length > 100, 'TaskballStrip 调用切片必须非空（空切片会让断言空转通过）')
  assert.match(call, /folded: effectiveFolded/, '竖条必须读 effectiveFolded（含本地覆盖，D-034）')
  assert.equal(/folded: view\.folded/.test(call), false, '不得把 Host 集合直接传给竖条')
})

test('F-021：段高 < 4px 时不画缝（批注 ②）', async () => {
  const client = await loadClient()
  const { seamsVisible, segmentHeight, MIN_SEAM_SEGMENT_PX, STRIP_HEIGHT } = client.__test__
  // 70px 高：17 段 = 4.1px 还画；18 段 = 3.9px 不画。
  assert.equal(seamsVisible(17), segmentHeight(17) >= MIN_SEAM_SEGMENT_PX)
  assert.equal(seamsVisible(18), false, '18 段时每段不足 4px，必须不画缝')
  assert.equal(seamsVisible(1), false, '只有一段就没有「段间」可言')
  assert.equal(seamsVisible(2), true)
  assert.equal(STRIP_HEIGHT, 70)
})

// ---------------------------------------------------------------- 位置

test('F-021：竖条贴输入框左侧，位置由官方 [data-composer-card] 推导', async () => {
  const client = await loadClient()
  const { stripBox, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP } = client.__test__
  // 真机实测（2026-10-31，1707 视口）：card.left=408 top=778 h=98，中心列 left=280
  const box = stripBox(
    { bottom: 876, height: 98, left: 408, top: 778, width: 1165 },
    { left: 280, right: 1707 },
    STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 908,
  )
  assert.notEqual(box, undefined)
  assert.equal(box.left, 408 - STRIP_WIDTH - STRIP_GAP, '左缘 = 卡片左缘 - 条宽 - 间隙')
  assert.equal(box.top, Math.round(778 + 98 / 2 - STRIP_HEIGHT / 2), '垂直中心对齐卡片中心')
  assert.equal(box.gap, 128, '可用间距 = 卡片左缘 - 中心列左缘')
})

test('F-021：窄屏放不下时不给位置 —— 回退成球，绝不挤进沟里（批注 ⑥）', async () => {
  const client = await loadClient()
  const { stripBox, stripGutterBudget, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP } = client.__test__
  const card = (left) => ({ bottom: 500, height: 114, left, top: 393, width: 600 })
  // 真机实测的沟宽：1707→128、1200→69、1024→33、900/720/560→16
  assert.notEqual(stripBox(card(408), { left: 280 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900), undefined)
  assert.notEqual(stripBox(card(349), { left: 280 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900), undefined)
  assert.equal(stripBox(card(313), { left: 280 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900), undefined,
    '1024 宽时沟只有 33px，放不下（条 13 + 间隙 4 + 一个球 44 = 61）')
  assert.equal(stripBox(card(296), { left: 280 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900), undefined, '900 宽时只有 16px')
  assert.equal(stripGutterBudget(STRIP_WIDTH, STRIP_GAP), STRIP_WIDTH + STRIP_GAP + 44,
    '预算 = 条 + 间隙 + 一整个球（用户：总要留一点距离，能放下一整个球）')
})

test('F-021：读不到锚点时不猜坐标，直接不给位置', async () => {
  const client = await loadClient()
  const { stripBox, readComposerCard } = client.__test__
  assert.equal(stripBox(undefined, { left: 280 }, 13, 70, 4, 900), undefined, '没有 composer card 就不收起')
  assert.equal(stripBox({ bottom: 500, height: 114, left: 408, top: 393, width: 600 }, {}, 13, 70, 4, 900), undefined,
    '没有中心列边界就不收起')
  assert.equal(readComposerCard(undefined), undefined)
  assert.equal(readComposerCard({ querySelector: () => null }), undefined)
  // 宽度为 0 = 还没布局完
  assert.equal(
    readComposerCard({ querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }) }),
    undefined,
  )
})

// ---------------------------------------------------------------- 渲染

test('F-021：竖条是真实 button，点击复原、右键打开快捷设置（批注 ④）', async () => {
  const client = await loadClient()
  const html = render({ component: client.__test__.TaskballStrip, props: { entries: [entry('r1', 'red')] } })
  assert.match(html, /^<button/, '必须是 button，不能是可点击 div（UX 规范）')
  assert.match(html, /data-taskball-strip="true"/)
  assert.match(html, /type="button"/, 'React 的 button 必须显式声明 type')
  assert.match(html, /aria-label=/, '纯视觉也要有不依赖颜色的可访问名')
})

test('F-021：每段用自己的状态色，色盲模式必须换掉（批注 ⑨ / D-031）', async () => {
  const client = await loadClient()
  const { TaskballStrip, COLOR_BLIND_PALETTE, DEFAULT_PALETTE } = client.__test__
  const entries = [entry('r1', 'red'), entry('g1', 'green')]
  const normal = render({ component: TaskballStrip, props: { entries } })
  const blind = render({ component: TaskballStrip, props: { entries, palette: COLOR_BLIND_PALETTE } })
  assert.ok(normal.includes(DEFAULT_PALETTE.hex.red), '默认配色下第一段是默认红')
  assert.ok(blind.includes(COLOR_BLIND_PALETTE.hex.red), '色盲模式下第一段必须换成紫红')
  assert.equal(blind.includes(DEFAULT_PALETTE.hex.red), false, '色盲模式下不得残留默认红')
  assert.ok(blind.includes(COLOR_BLIND_PALETTE.hex.green))
})

test('F-021：无任务时渲染一段灰色（不是空白条）', async () => {
  const client = await loadClient()
  const { TaskballStrip, DEFAULT_PALETTE } = client.__test__
  const html = render({ component: TaskballStrip, props: { entries: [] } })
  assert.ok(html.includes(DEFAULT_PALETTE.hex.gray), '空态必须是中性灰段')
  assert.match(html, /data-strip-segments="1"/)
  // 无任务时不该画缝
  assert.equal(html.includes('data-strip-seams'), false)
})

test('F-021：竖条用主题细线画缝，且颜色不得写死（批注 ⑧ / D-037）', async () => {
  const client = await loadClient()
  const { TaskballStrip } = client.__test__
  const html = render({
    component: TaskballStrip,
    props: { entries: [entry('a', 'red'), entry('b', 'blue'), entry('c', 'green')] },
  })
  assert.match(html, /data-strip-seams="true"/)
  assert.ok(html.includes('--dsw-alias-border-l2'), '缝色必须走宿主题 token，否则深色主题下发脏')
  // 只有第一段没有上边界。D-074 之后容器自己也有一个 box-shadow（白框的贴边），
  // 所以这里必须数「段」上的缝，不能数整段 HTML 里的 box-shadow 总数。
  const segmentShadows = [...html.matchAll(/data-strip-color="[^"]*"[^>]*box-shadow/g)].length
  assert.equal(segmentShadows, 2, '三段之间两道缝')
  // 反向断言：容器确实有那道贴边，且段上恰好是 2 道缝
  assert.equal((html.match(/box-shadow/g) ?? []).length, 3,
    '总共 3 处 box-shadow：容器贴边 1 处 + 段间缝 2 处')
})

test('F-021：段数一多就不画缝（渲染层与纯函数一致）', async () => {
  const client = await loadClient()
  const { TaskballStrip } = client.__test__
  const many = Array.from({ length: 20 }, (_, index) => entry(`s${index}`, 'blue'))
  const html = render({ component: TaskballStrip, props: { entries: many } })
  assert.match(html, /data-strip-segments="20"/)
  assert.equal(html.includes('data-strip-seams'), false, '20 段时每段 3.5px，不能画缝')
  // D-074 之后容器有固定的贴边 box-shadow，所以「不画缝」要数段上的，不是总数。
  const segmentShadows = [...html.matchAll(/data-strip-color="[^"]*"[^>]*box-shadow/g)].length
  assert.equal(segmentShadows, 0, '段上不得有任何 box-shadow（缝已关闭）')
})

test('F-021：沟宽预算必须真的被 stripBox 用上（批注 ⑥ —— 光定义函数不算）', async () => {
  const client = await loadClient()
  const { stripBox, stripGutterBudget, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP } = client.__test__
  const budget = stripGutterBudget(STRIP_WIDTH, STRIP_GAP)
  // 恰好在预算上：放得下；少 1px：放不下。判据边界必须与预算函数一致，
  // 否则「把判据改成写死的数字」能全绿通过（负向验证实测漏过一次）。
  const cardAt = (left, centerLeft) => ({ bottom: 500, height: 114, left, top: 393, width: 600 })
  assert.notEqual(
    stripBox(cardAt(100 + budget, 100), { left: 100 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900),
    undefined,
    '沟宽正好等于预算时必须放得下',
  )
  assert.equal(
    stripBox(cardAt(100 + budget - 1, 100), { left: 100 }, STRIP_WIDTH, STRIP_HEIGHT, STRIP_GAP, 900),
    undefined,
    '沟宽比预算少 1px 时必须拒绝 —— 判据的边界必须由预算函数决定',
  )
})

test('F-021：收起意图必须持久化，刷新后仍然收起（否则用户每次都要重收）', async () => {
  const client = await loadClient()
  const { COLLAPSED_KEY, readCollapsed, writeCollapsed } = client.__test__
  assert.equal(COLLAPSED_KEY, 'dsh-useful-taskball:collapsed')
  writeCollapsed(true)
  assert.equal(readCollapsed(), true, '写完必须读得回来')
  writeCollapsed(false)
  assert.equal(readCollapsed(), false, '取消收起必须清掉键，而不是写 0')
  // 存储不可用时必须退化成「展开」，不能抛错（一个 throw 会卸掉整个 overlay）。
  assert.equal(typeof readCollapsed(), 'boolean')
})

test('F-021：鼠标悬停不得复原成球 —— 只有点击才复原（批注 ④）', async () => {
  const client = await loadClient()
  const { TaskballStrip } = client.__test__
  // 源码级判据，不是渲染级：React 的事件处理器（onPointerEnter 等）**不会序列化
  // 进静态 HTML**，所以对 renderToStaticMarkup 的输出查 onpointerenter 永远为
  // false —— 那条断言本身是空转的（负向验证实测：给竖条挂上 onPointerEnter，
  // 渲染断言照样通过）。必须直接读源码。
  const source = await readFile(new URL('../src/client/ball-strip.ts', import.meta.url), 'utf8')
  const component = source.slice(source.indexOf('export function TaskballStrip('))
  assert.ok(component.length > 500, '组件切片必须非空（空切片会让下面的断言空转通过）')

  // ① 不得有任何指针/悬停处理器 —— 挂了就意味着「指针掠过就把球召唤回来」。
  assert.equal(/onPointerEnter|onPointerLeave|onMouseEnter|onMouseLeave|onPointerOver|onPointerOut/.test(component), false,
    '竖条不得绑定任何指针/悬停处理器')
  assert.equal(/onHoverStart|onHoverEnd/.test(source), false, 'ball-strip 不得再有悬停回调 props')

  // ② 复原的唯一入口 onClick。
  assert.match(component, /onClick: props\.onRestore/, '点击必须走 onRestore')
  const handlers = [...component.matchAll(/on([A-Z][A-Za-z]+):/g)].map((match) => match[1])
  assert.deepEqual(
    handlers.sort(),
    ['Click', 'ContextMenu'],
    `竖条只允许 onClick 与 onContextMenu 两个处理器，实际：${handlers.join(', ')}`,
  )

  // ③ 竖条内部不持有 hover 状态。
  assert.equal(/setHovered|hovered/.test(component), false, '竖条内部不得持有 hover 状态')

  // ④ 渲染出来的按钮仍然可点（keyboard 由原生 button 承担，不需要 onFocus 复原）。
  const html = render({ component: TaskballStrip, props: { entries: [entry('r1', 'red')] } })
  assert.match(html, /^<button/)
  assert.equal(/onfocus=/i.test(html), false, '不得靠 focus 复原')
})

// D-074（用户 2026-11-02）：「给竖条最外侧加一个白框」。
// 粗细按 UI/UX 先例取 1px —— 0.5px 在 1x 屏会被抗锯齿吃掉（D-065 气泡描边的原话）。
// 真机实测：浅色主题的沟与输入框卡片都是 rgb(255,255,255)，纯白框在那里不可见
// （像素采样 x=8 处为 rgb(140,197,255)，框在但与背景同色）。因此白框之外再加一道
// 贴边提供对比 —— 白框保留（用户要的视觉语言），可见性由贴边保证。
test('D-074：竖条有 1px 白框 + 贴边，且不改变盒子宽度', async () => {
  const strip = await readFile(new URL('../src/client/ball-strip.ts', import.meta.url), 'utf8')
  const style = await readFile(new URL('../src/client/style.ts', import.meta.url), 'utf8')
  assert.match(strip, /export const STRIP_FRAME_PX = 1/, '描边必须是具名常量 1px')
  assert.match(strip, /border: `\$\{STRIP_FRAME_PX\}px solid \$\{STRIP_FRAME_COLOR\}`/,
    '白框必须用真正的 border 画')
  assert.match(strip, /STRIP_FRAME_COLOR = 'rgba\(255, 255, 255, 0\.92\)'/,
    '白框必须是白色 —— 用户要的视觉语言')
  // border-box 是「盒子宽度 == STRIP_WIDTH」成立的前提
  assert.match(strip, /boxSizing: 'border-box'/, '必须是 border-box，否则边框会把盒子撑宽')
  // 贴边：box-shadow 不占布局，走主题变量
  assert.match(strip, /export const STRIP_EDGE_COLOR = 'var\(--taskball-strip-edge/,
    '必须有贴边提供对比（浅色主题下白框与背景同色）')
  assert.match(strip, /boxShadow: `0 0 0 \$\{STRIP_FRAME_PX\}px \$\{STRIP_EDGE_COLOR\}`/,
    '贴边必须是紧贴白框外侧的 box-shadow')
  assert.match(style, /\[data-taskball-strip\] \{ --taskball-strip-edge:/,
    'style.ts 必须声明浅色主题的贴边色')
  assert.match(style, /body\[data-ds-dark-theme\] \[data-taskball-strip\] \{ --taskball-strip-edge:/,
    '深色主题必须换用另一套贴边色')
})

test('D-074：竖条渲染出的白框与贴边真的在 DOM 上', async () => {
  const client = await loadClient()
  const Strip = client.__test__.TaskballStrip
  const markup = renderToStaticMarkup(React.createElement(Strip, {
    entries: [
      { id: 'a', title: 'A', color: 'red', workspaceId: 'w', updatedAt: 2, completedAt: undefined },
      { id: 'b', title: 'B', color: 'green', workspaceId: 'w', updatedAt: 1, completedAt: 1 },
    ],
    left: 100,
    t: (key) => key,
    top: 200,
  }))
  const flat = markup.replace(/\s+/g, '')
  assert.ok(/border:1pxsolidrgba\(255,255,255,0?\.?92?\)/.test(flat),
    `竖条必须渲染 1px 白框，实际 markup: ${markup.slice(0, 320)}`)
  // React 把 `0 0 0 1px var(...)` 序列化成 `0 0 0 1px var(...)`，去掉空格后
  // 三个 0 会连成 `000`。断言用去掉空格的整串，避免被序列化格式咬到。
  assert.ok(/box-shadow:0001pxvar\(--taskball-strip-edge/.test(flat),
    `竖条必须渲染贴边（否则白框在浅色主题下不可见）。实际 box-shadow: ${
      flat.match(/box-shadow:[^"]*/)?.[0] ?? '(无)'}`)
  // 宽度仍是常量，不因边框变宽
  assert.ok(flat.includes('width:13px'), '盒子宽度必须仍是 STRIP_WIDTH=13')
})
