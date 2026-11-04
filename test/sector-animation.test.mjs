// F-010 测试：动画渐变的不变量
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

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
    CSS: { registerProperty() {} },
  }
  vm.runInNewContext(source, { window })
  return client
}

const client = loadClient()
const {
  MAX_ANIMATED_BOUNDARIES,
  animatedBallGradient,
  canAnimateSlices,
  sectorVariables,
} = client.__test__

const PALETTE = {
  red: '#f16662', yellow: '#ffac50', blue: '#52a7ff', green: '#47d489', gray: '#c3ccd9',
}

const slicesOf = (count) => {
  const colors = ['red', 'yellow', 'blue', 'green']
  return Array.from({ length: count }, (_, index) => ({
    color: colors[index % colors.length],
    start: (360 / count) * index,
    end: (360 / count) * (index + 1),
  }))
}

// 方案 (b) 的全部可行性都压在「梯度字符串恒定」这一条上：浏览器只有在色标列表
// 结构完全相同时才会插值，否则直接换帧。所以这条必须先锁死。
test('F-010：动画梯度字符串必须恒定，只靠变量值变化', () => {
  const first = animatedBallGradient(PALETTE)
  const second = animatedBallGradient(PALETTE)
  const third = animatedBallGradient({ ...PALETTE, red: '#000000' })
  assert.equal(first, second, '同一 palette 下两次调用必须完全相同')
  assert.equal(first, third, '梯度字符串不得内联任何颜色字面量 —— 颜色必须走 --taskball-c 变量')

  // 每个槽位 3 个 stop（接缝 / 填充 / 接缝），槽位数固定
  const slots = first.split('calc(').length - 1
  assert.ok(slots >= MAX_ANIMATED_BOUNDARIES * 3, `色标片段应随槽位固定（实际 ${slots}）`)

  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    assert.ok(first.includes(`--taskball-b${index}`), `槽位 ${index} 的边界变量必须出现`)
    assert.ok(first.includes(`--taskball-c${index}`), `槽位 ${index} 的颜色变量必须出现`)
  }
})

test('F-010：扇区数变化只改变量值，不改变梯度结构', () => {
  const gradient = animatedBallGradient(PALETTE)
  const shapes = [0, 1, 2, 3, 4].map(() => animatedBallGradient(PALETTE))
  assert.equal(new Set(shapes).size, 1, '不同扇区数下梯度字符串必须一致')

  // 角度随扇区数变化
  const two = sectorVariables(slicesOf(2), PALETTE)
  const three = sectorVariables(slicesOf(3), PALETTE)
  assert.equal(two['--taskball-b0'], '180deg')
  assert.equal(two['--taskball-b1'], '360deg')
  assert.equal(three['--taskball-b0'], '120deg')
  assert.equal(three['--taskball-b1'], '240deg')
  assert.equal(three['--taskball-b2'], '360deg')

  // 颜色按槽位填充，多余槽位落到 idle 灰
  assert.equal(two['--taskball-c0'], PALETTE.red)
  assert.equal(two['--taskball-c1'], PALETTE.yellow)
  assert.equal(two['--taskball-c2'], PALETTE.gray)
  assert.equal(two['--taskball-c7'], PALETTE.gray)
})

test('F-010：超过槽位上限时退回静态渐变（不丢扇区）', () => {
  assert.equal(canAnimateSlices(slicesOf(MAX_ANIMATED_BOUNDARIES)), true, '恰好上限仍可动画')
  assert.equal(canAnimateSlices(slicesOf(MAX_ANIMATED_BOUNDARIES + 1)), false, '超过上限必须退化')
  assert.equal(canAnimateSlices([]), true, '空环也要可动画（否则空态切换会跳变）')
})

// 用户 2026-10-30 报：「球在闲置状态时，扇区有一个竖线」。根因是动画渐变的接缝
// 用的是字面量 `min(SEAM_DEG/2, span * 0.2)`：空环时槽位 0 跨 0→360deg，接缝照画，
// 于是在 12 点方向留下一道约 1.75px 的白色楔形。静态渐变本来就有 `span >= 359.9`
// 的分支，只有动画分支漏了。修法是把接缝宽度也做成注册变量（能归零，且字符串恒定）。
test('接缝宽度：没有真实分界时必须为 0（闲置态与满圆单扇区）', () => {
  const { seamAngleOf } = client.__test__

  // 空环：8 个槽位全钉在 360deg，一个分界都不存在
  const idle = sectorVariables([], PALETTE)
  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    assert.equal(idle[`--taskball-s${index}`], '0deg', `闲置态槽位 ${index} 的接缝必须为 0`)
  }

  // 单个满圆扇区：几何上也没有分界（与静态渐变 span >= 359.9 的分支对齐）
  const full = sectorVariables([{ color: 'red', start: 0, end: 360 }], PALETTE)
  assert.equal(full['--taskball-s0'], '0deg', '满圆单扇区不得画接缝')
  assert.equal(seamAngleOf({ color: 'red', start: 0, end: 360 }, 0, 360), 0)

  // 真实分界必须保留接缝，否则扇区之间会糊成一片
  const two = sectorVariables(slicesOf(2), PALETTE)
  assert.notEqual(two['--taskball-s0'], '0deg', '两个扇区的分界必须仍有接缝')
  assert.notEqual(two['--taskball-s1'], '0deg', '两个扇区的分界必须仍有接缝')
  assert.equal(two['--taskball-s2'], '0deg', '没有扇区的槽位接缝必须为 0')

  // 零宽槽位（无扇区）一律 0
  assert.equal(seamAngleOf(undefined, 0, 360), 0, '无扇区槽位必须 0')
  assert.equal(seamAngleOf({ color: 'red', start: 0, end: 0 }, 0, 0), 0, '零宽槽位必须 0')
})

test('接缝宽度走变量，渐变字符串不得再内联接缝公式', () => {
  const gradient = animatedBallGradient(PALETTE)
  // 字面量公式无法区分「有分界」与「没有分界」，这正是竖线的成因
  assert.equal(gradient.includes('min('), false, '渐变里不得再有 min() 字面量接缝公式')
  for (let index = 0; index < MAX_ANIMATED_BOUNDARIES; index += 1) {
    assert.ok(gradient.includes(`--taskball-s${index}`), `槽位 ${index} 的接缝宽度必须读变量`)
  }
  // 恒定字符串这一条不能因为改接缝而丢掉
  assert.equal(gradient, animatedBallGradient(PALETTE), '接缝改造后梯度字符串仍必须恒定')
})

// 注册是「能过渡」的前提：没注册的属性根本无法参与过渡。
test('F-010：边界与颜色变量必须在 apply 里注册，且样式表里有对应 transition', () => {
  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(/registerBoundaryProperties\(\)/.test(index), 'apply 必须调用 registerBoundaryProperties')
  assert.ok(
    index.indexOf('injectStyle') < index.indexOf('registerBoundaryProperties()'),
    '样式注入仍须在最前，注册紧随其后',
  )

  const visual = readFileSync(new URL('../src/client/ball-visual.ts', import.meta.url), 'utf8')
  assert.ok(/syntax: '<angle>'/.test(visual), '边界必须以 <angle> 注册，否则不可插值')
  assert.ok(/syntax: '<color>'/.test(visual), '填充必须以 <color> 注册，否则换色会硬切')
  // 接缝宽度也必须是注册过的 <angle>：没注册的变量不参与过渡，接缝会硬跳
  const seamRegistrations = visual.match(/name: seamVar\(index\)[\s\S]{0,80}?syntax: '<angle>'/g)
  assert.ok(seamRegistrations !== null && seamRegistrations.length === 1,
    '接缝宽度必须以 <angle> 注册，否则滑入滑出时会硬跳')

  const style = readFileSync(new URL('../src/client/style.ts', import.meta.url), 'utf8')
  assert.ok(/--taskball-b0 200ms/.test(style), '样式表必须给边界变量过渡时长')
  assert.ok(/--taskball-c0 200ms/.test(style), '样式表必须给颜色变量过渡时长')
  // 接缝宽度是注册过的 <angle>，没有过渡它会硬跳；有过渡才能随边界滑入滑出
  assert.ok(/--taskball-s0 200ms/.test(style), '样式表必须给接缝宽度变量过渡时长')
  assert.ok(/--taskball-s7 200ms/.test(style), '8 个槽位的接缝变量都要有过渡')

  // reduced-motion 下必须直接落终态
  const reduced = style.slice(style.indexOf('prefers-reduced-motion'))
  assert.ok(/\[data-taskball-ball\]/.test(reduced), 'reduced-motion 块必须覆盖球')

  const ball = readFileSync(new URL('../src/client/ball.ts', import.meta.url), 'utf8')
  assert.ok(/animatedBallStyle\(/.test(ball), '球必须使用动画样式')
  assert.ok(/canAnimateSlices\(/.test(ball), '球必须在超限时退回静态渐变')
})

// F-018（用户 2026-11-01）：球大小可调后，接缝必须跟着缩放。
//
// 接缝的「视觉权重」是按 1.75 CSS px 调的 —— 那是个固定的像素宽度。球的直径
// 变成用户可调之后，它的**角度**必须随直径反比变化，否则 56px 球上的接缝会按
// 44px 的半径算出来，看起来偏细。锁的是「角度随尺寸变」+「像素宽度恒定」。
test('F-018：接缝角度随球直径反比缩放，但视觉像素宽度恒定', async () => {
  const client = loadClient()
  const { seamAngleOf } = client.__test__
  assert.equal(typeof seamAngleOf, 'function', 'seamAngleOf 必须可从 __test__ 取到')

  const slice = { color: 'red', start: 0, end: 90 }
  const small = seamAngleOf(slice, 0, 90, 36)
  const medium = seamAngleOf(slice, 0, 90, 44)
  const large = seamAngleOf(slice, 0, 90, 56)

  // 角度随球变大而变小（同一段 90° 扇区的边界）
  assert.ok(small > medium && medium > large,
    `接缝角度必须随球变大而变小，实得 small=${small} medium=${medium} large=${large}`)

  // 反推像素宽度：角度(弧度) × 色盘半径 = 像素宽。三个档位都必须≈1.75px。
  const FRAME = 1.5
  const SEAM_PX = 1.75
  for (const [px, deg] of [[36, small], [44, medium], [56, large]]) {
    const radius = (px - FRAME * 2) / 2
    // seamAngleOf 返回的是「半角」（缝在扇区边界两侧各占一半），所以像素宽 = 2 × 半角 × 半径
    const impliedPx = (deg * Math.PI / 180) * radius * 2
    assert.ok(Math.abs(impliedPx - SEAM_PX) < 0.01,
      `球 ${px}px 时接缝的视觉宽度必须是 ${SEAM_PX}px，实得 ${impliedPx.toFixed(3)}px`)
  }

  // 不传尺寸时必须退回 44px 的设计值（旧调用点不能塌）
  assert.equal(seamAngleOf(slice, 0, 90), medium, '不传尺寸时必须退回 44px 设计值')
})
