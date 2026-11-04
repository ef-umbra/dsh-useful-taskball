// F-020 快捷面板扩容（用户 2026-11-01：从剩下 8 项里挑，选定「显示已处理区」+「面板字号」）
//
// 这次扩容的约束不是「能加几项」，而是 **加的必须是已存在的字段**：D-044 定下快捷
// 面板「不是第二个设置页」，判断标准是它有没有新增设置入口的注册；而字段层面同理
// —— 它只能 surface `FIELDS` 里已有的项，自造一个就等于第二个 owner。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

function loadClient() {
  const source = require('node:fs').readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1400, innerHeight: 900,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    CSS: { registerProperty() {} },
  }
  vm.runInNewContext(source, {
    window, localStorage: window.localStorage,
    innerWidth: 1400, innerHeight: 900,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  return client
}

test('F-020 / D-073：快捷面板的每一项都必须是 FIELDS 里已有的字段', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  const settings = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')

  const declared = new Set([...settings.matchAll(/field: '([a-zA-Z]+)'/g)].map((m) => m[1]))
  const offered = new Set([
    ...[...quick.matchAll(/onSet\('([a-zA-Z]+)'/g)].map((m) => m[1]),
    ...[...quick.matchAll(/switchRow\('([a-zA-Z]+)'/g)].map((m) => m[1]),
  ])

  // D-073（用户 2026-11-02）重排了行集：状态表示与色盲配色移出，球大小移入。
  for (const field of ['panelFrosted', 'bubbleOnCompletion', 'panelOpacity']) {
    assert.ok(offered.has(field), `设置项 ${field} 不得从快捷面板消失`)
  }
  assert.ok(offered.has('showFoldedSection'), '「显示已处理区」必须保留')
  assert.ok(offered.has('fontSizeMode'), '字号模式必须保留')
  assert.ok(offered.has('fontSizePx'), '自定义字号必须保留')
  assert.ok(offered.has('ballSize'), 'D-073：球大小必须放进快捷面板')
  // 反向断言 —— 「删了」和「还在」是两条独立事实
  assert.equal(offered.has('statusMarker'), false, 'D-073：状态表示不得再出现在快捷面板')
  assert.equal(offered.has('colorBlindMode'), false, 'D-073：色盲配色不得再出现在快捷面板')

  // 关键约束：不得自造字段
  for (const field of offered) {
    assert.ok(declared.has(field), `快捷面板写的 '${field}' 必须是 FIELDS 里已有的字段 —— D-044 的「不是第二个设置页」在字段层面同样成立`)
  }
})

test('D-073：打开全部设置与收起同排一行，且收起的小字注解已删除', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  assert.match(quick, /'data-taskball-quick-actions': 'true'[\s\S]{0,80}display: 'flex'/,
    '两个出口必须放在同一行')
  assert.match(quick, /'data-taskball-open-all': 'true'/, '打开全部设置必须有稳定锚点')
  assert.match(quick, /'data-taskball-collapse': 'true'/, '收起按钮必须有稳定锚点')
  assert.equal(/quick\.collapseHint/.test(quick), false,
    '收起按钮下方的小字注解必须删除（用户 2026-11-02）')
})

test('F-020：自定义字号只在 Custom 模式下渲染', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  // 条件渲染：host 模式下 px 输入框既无意义也会误导
  assert.match(quick, /values\.fontSizeMode !== 'custom'[\s\S]{0,60}\? null/,
    'host 模式下不得渲染自定义字号输入 —— 那个值在 host 模式下被完全忽略')
  assert.match(quick, /data-taskball-quick-fontsize/, '自定义字号输入需要稳定锚点')
})

test('F-020：扩容后面板高度估算与上限必须同步调整', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  assert.match(quick, /const QUICK_ESTIMATED_HEIGHT = 384/,
    '估算高度必须从 288 调到 384（否则 7 项时会在本放得下的窗口上翻到球上方）')
  assert.match(quick, /const QUICK_MAX_HEIGHT = 420/,
    '上限必须从 360 抬到 420（否则 7 项被裁掉）')
})

test('F-020：快捷面板仍然不注册任何 slot（D-044 的红线）', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  assert.equal(/slots\.register/.test(quick), false,
    '快捷面板不得自己注册 slot —— 那就会变成第二个设置入口')
  assert.equal(/slots\.inject/.test(quick), false, '同上')

  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // 整个客户端只允许两处 slot 注册（overlay + bundle.config）
  const registrations = [...index.matchAll(/ctx\.slots\.register\(/g)]
  assert.equal(registrations.length, 2,
    `客户端只允许 2 处 slot 注册（shell.overlay + plugins.bundle.config），实得 ${registrations.length}`)
})

test('F-020：改值仍走唯一 writer，快捷面板不自持 form', async () => {
  // Strip comments first: this file NAMES `configForms` in prose to explain why it
  // must not reach for one, so a naive substring gate fails on its own docs.
  const quick = (await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/\.mutate\(/.test(quick), false, '快捷面板不得直接 mutate 共享 form')
  assert.equal(/configForms/.test(quick), false, '快捷面板不得自己去取 form')

  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(index, /settingsSession\.writer\.set\(field, value\)/,
    '快捷面板的写必须经 settingsSession.writer')
})

test('F-020：字号输入框用 number 而非任意文本', async () => {
  const quick = await readFile(new URL('../src/client/quick.ts', import.meta.url), 'utf8')
  const block = quick.slice(quick.indexOf('data-taskball-quick-fontsize'))
  assert.ok(block.length > 100, '字号输入切片必须非空')
  assert.match(block, /type: 'number'/, '必须是 number 输入，靠浏览器挡掉非数字')
  assert.match(block, /min: FONT_SIZE_MIN_PX/, '必须有下限')
  assert.match(block, /max: FONT_SIZE_MAX_PX/, '必须有上限')
  // 非法输入不得写进去
  assert.match(block, /if \(Number\.isFinite\(next\)\)/, '非有限数不得写设置')
})
