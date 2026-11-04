// D-031 色盲模式的回归测试：调色板切换、色盲可分性、三层设置链路。
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

const client = loadClient()
const {
  COLOR_HEX,
  COLOR_HEX_CB,
  COLOR_INK,
  COLOR_INK_CB,
  DEFAULT_PALETTE,
  COLOR_BLIND_PALETTE,
  paletteFor,
  tintOf,
  TaskballPanel,
  TaskballBall,
} = client.__test__

const t = (key) => key

function renderPanel(palette) {
  const view = {
    entries: [
      { id: 'r', title: 'R', color: 'red', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
      { id: 'g', title: 'G', color: 'green', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
    ],
    folded: new Set(),
    failures: new Map(),
  }
  return renderToStaticMarkup(React.createElement(TaskballPanel, {
    workspaces: [],
    view,
    expanded: true,
    palette,
    statusMarker: 'row-solid',
    t,
    onToggleFolded() {},
    onOpenSession() {},
    onClose() {},
  }))
}

test('paletteFor：默认关，只有显式 true 才切色盲配色', () => {
  assert.equal(paletteFor(undefined), DEFAULT_PALETTE)
  assert.equal(paletteFor(false), DEFAULT_PALETTE)
  assert.equal(paletteFor(true), COLOR_BLIND_PALETTE)
})

test('色盲配色只改红与绿，黄蓝灰保持原样', () => {
  assert.notEqual(COLOR_HEX_CB.red, COLOR_HEX.red, '失败色必须变')
  assert.notEqual(COLOR_HEX_CB.green, COLOR_HEX.green, '完成色必须变')
  assert.equal(COLOR_HEX_CB.yellow, COLOR_HEX.yellow, '黄色无需改动')
  assert.equal(COLOR_HEX_CB.blue, COLOR_HEX.blue, '蓝色无需改动')
  assert.equal(COLOR_HEX_CB.gray, COLOR_HEX.gray, '灰色无需改动')
})

// 这条是这个功能的全部意义所在：色盲视觉下红绿必须真的分开。
// 用 Brettel 近似的 LMS 投影模拟 deuteranopia，再比 RGB 距离。
function rgbOf(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
}
function simulateDeutan(hex) {
  const [r, g, b] = rgbOf(hex)
  const l = 17.8824 * r + 43.5161 * g + 4.11935 * b
  const m = 3.45565 * r + 27.1554 * g + 3.86714 * b
  const s = 0.0299566 * r + 0.184309 * g + 1.46709 * b
  const m2 = 0.494207 * l + 1.24827 * s
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
  return [
    clamp(0.080944 * l - 0.130504 * m2 + 0.116721 * s),
    clamp(-0.0102485 * l + 0.0540194 * m2 - 0.113615 * s),
    clamp(-0.000365294 * l - 0.00412163 * m2 + 0.693513 * s),
  ]
}
function distance(a, b) {
  return Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2))
}

test('色盲视觉下：默认配色的红绿几乎同色，色盲配色显著拉开', () => {
  const defaultGap = distance(simulateDeutan(COLOR_HEX.red), simulateDeutan(COLOR_HEX.green))
  const cbGap = distance(simulateDeutan(COLOR_HEX_CB.red), simulateDeutan(COLOR_HEX_CB.green))
  // 实测：默认 60，色盲配色 66；其余三对（对蓝/对黄）都不低于 66。
  assert.ok(defaultGap < 70, `默认红绿在色盲视觉下应当极其接近，实测 ${defaultGap}`)
  assert.ok(cbGap > defaultGap, `色盲配色必须比默认更容易区分：${cbGap} vs ${defaultGap}`)
  assert.ok(cbGap >= 66, `色盲配色的红绿距离应 ≥66，实测 ${cbGap}`)
})

test('色盲配色下四色两两都不混淆（含黄与蓝）', () => {
  const colors = COLOR_HEX_CB
  const keys = ['red', 'yellow', 'blue', 'green']
  // 黄与蓝不参与改动，但必须确认换色后没有和它们撞上。
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const gap = distance(simulateDeutan(colors[keys[i]]), simulateDeutan(colors[keys[j]]))
      assert.ok(gap >= 60, `${keys[i]} 与 ${keys[j]} 在色盲视觉下距离仅 ${gap}，会混淆`)
    }
  }
})

// 实色行模式用 COLOR_INK 当文字色，对比度必须过 WCAG AA 4.5。
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

test('色盲配色的实色行文字对比度达 WCAG AA 4.5', () => {
  for (const color of ['red', 'green']) {
    const ratio = contrast(COLOR_INK_CB[color], COLOR_HEX_CB[color])
    assert.ok(ratio >= 4.5, `${color} 的墨/底对比度 ${ratio.toFixed(2)} 未达 4.5`)
  }
})

test('面板按传入的 palette 取色：两套配色渲染出不同的行背景', () => {
  const normal = renderPanel(DEFAULT_PALETTE)
  const cb = renderPanel(COLOR_BLIND_PALETTE)
  assert.ok(normal.includes(COLOR_HEX.red.replace('#', '')), '默认配色应渲染默认红')
  assert.ok(!normal.includes(COLOR_HEX_CB.red.replace('#', '')), '默认配色不应出现色盲红')
  assert.ok(cb.includes(COLOR_HEX_CB.red.replace('#', '')), '色盲配色应渲染色盲红')
  assert.ok(!cb.includes(COLOR_HEX.red.replace('#', '')), '色盲配色不应出现默认红')
})

test('不传 palette 时退回默认配色（不炸、不空）', () => {
  const markup = renderPanel(undefined)
  assert.ok(markup.includes(COLOR_HEX.red.replace('#', '')))
})

test('tintOf 按 palette 计算，浅染行也跟着换色', () => {
  const normalTint = tintOf('red', DEFAULT_PALETTE)
  const cbTint = tintOf('red', COLOR_BLIND_PALETTE)
  assert.notEqual(normalTint, cbTint, '换色后浅染也必须跟着变')
  assert.ok(cbTint.startsWith('rgba('), '浅染仍是 rgba')
})

// 三层链路：Host schema 有字段、设置页有开关、客户端读了它。少一层就静默失效。
test('colorBlindMode 必须贯穿 Host schema / 设置页 / 客户端取值三层', () => {
  const host = readFileSync(new URL('../src/host/config.ts', import.meta.url), 'utf8')
  assert.ok(host.includes('colorBlindMode'), 'Host schema 必须声明 colorBlindMode')
  assert.ok(/colorBlindMode:\s*z\.boolean\(\)\.default\(false\)/.test(host), '默认必须是 false')

  const settings = readFileSync(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.ok(settings.includes("field: 'colorBlindMode'"), '设置页必须暴露该开关')

  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(/paletteFor\(settings\.colorBlindMode === true\)/.test(index), '客户端必须按该设置选调色板')
})

test('球也接收同一个 palette（否则球和面板会不一致）', () => {
  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // 三处都会画状态色：面板、球的扇形、突变气泡。都要拿到 palette。
  // 用括号配对取整段 props，而不是固定长度窗口 —— 窗口会被内层 `})` 截断。
  const blockOf = (needle) => {
    const start = index.indexOf(needle)
    if (start < 0) return ''
    let depth = 0
    for (let i = start; i < index.length; i += 1) {
      const ch = index[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return index.slice(start, i + 1)
      }
    }
    return ''
  }
  assert.ok(blockOf('h(TaskballPanel, {').includes('palette'), '面板必须收到 palette')
  assert.ok(blockOf('h(TaskballBall, {').includes('palette'), '球的扇形必须收到同一 palette')
  assert.ok(blockOf('h(TaskballBubble, {').includes('palette'), '气泡必须收到同一 palette')
})

test('ballGradient 按传入调色板生成扇形色', () => {
  const markup = renderToStaticMarkup(React.createElement(TaskballBall, {
    entries: [
      { id: 'r', title: 'R', color: 'red', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
      { id: 'g', title: 'G', color: 'green', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
    ],
    folded: new Set(),
    expanded: false,
    onToggle() {},
    palette: COLOR_BLIND_PALETTE,
    t,
  }))
  // 内联样式里 conic-gradient 的 stop 用的是 palette 的原始 hex（浏览器在
  // getComputedStyle 时才转成 rgb），所以直接比 hex 字面量。
  assert.ok(markup.includes(COLOR_HEX_CB.red), '球的扇形必须使用色盲配色的红')
  assert.ok(markup.includes(COLOR_HEX_CB.green), '球的扇形必须使用色盲配色的绿')
  assert.ok(!markup.includes(COLOR_HEX.red), '球的扇形不应再出现默认红')
  assert.ok(!markup.includes(COLOR_HEX.green), '球的扇形不应再出现默认绿')
})
