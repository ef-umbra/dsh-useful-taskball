// F-019 吸附触发距离可调（用户 2026-11-01：0–48px，0 = 关闭吸附）
//
// 关键语义不是「距离可调」本身，而是 **0 必须真的关掉**。这条最容易写错：
// `nearest(targets, value, 0)` 在球正好落在线上时仍然返回目标，于是「关闭吸附」
// 的用户每次恰好在边界附近松手还是会被吸过去 —— 表现就是「设置没生效」。

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
    window,
    localStorage: window.localStorage,
    innerWidth: 1400,
    innerHeight: 900,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  return client
}

/** A pair of snap lines: x=100 and x=500; y=50 and y=800. */
const targets = {
  x: [{ kind: 'left', position: 100 }, { kind: 'rightbar', position: 500 }],
  y: [{ kind: 'top', position: 50 }, { kind: 'bottom', position: 800 }],
}

test('F-019：距离内的释放会吸附，距离外的不动', async () => {
  const { snapPosition } = loadClient().__test__

  // 距 x=100 只有 5px → 16px 的默认距离内，必须吸过去
  const near = snapPosition({ x: 105, y: 55 }, targets, 16)
  assert.equal(near.position.x, 100, '16px 内必须吸到线上')
  assert.equal(near.attachment.x, 'left')

  // 距 x=100 有 30px → 超出 16px，不得吸附
  const far = snapPosition({ x: 130, y: 300 }, targets, 16)
  assert.equal(far.position.x, 130, '超出距离不得吸附')
  assert.equal(far.position.y, 300)
  assert.equal(far.attachment.x, undefined)
})

test('F-019：距离可调 —— 同一个位置在不同距离下结果不同', async () => {
  const { snapPosition } = loadClient().__test__
  const position = { x: 130, y: 300 }   // 距 x=100 恰好 30px

  assert.equal(snapPosition(position, targets, 16).position.x, 130, '16px 时不该吸')
  assert.equal(snapPosition(position, targets, 32).position.x, 100, '32px 时应该吸')
  assert.equal(snapPosition(position, targets, 48).position.x, 100, '48px 时也应该吸')
})

test('F-019：0 = 完全关闭吸附，连「正落在线上」也不吸', async () => {
  const { snapPosition } = loadClient().__test__

  // 精确落在线上：nearest 用 distance=0 时 current=0 > 0 不成立，会返回目标 ——
  // 所以「关闭」必须由 snapPosition 自己判，不能指望 nearest。
  const exactly = snapPosition({ x: 100, y: 50 }, targets, 0)
  assert.equal(exactly.position.x, 100, '位置保持不动')
  assert.equal(exactly.position.y, 50)
  assert.equal(exactly.attachment.x, undefined, '关闭吸附时不得产生 attachment')
  assert.equal(exactly.attachment.y, undefined)

  // 就在线旁边 1px 也不能吸
  const adjacent = snapPosition({ x: 101, y: 51 }, targets, 0)
  assert.equal(adjacent.attachment.x, undefined)
  assert.equal(adjacent.position.x, 101)
})

test('F-019：0 = 关闭时，已吸附的球必须解除吸附', async () => {
  const source = await readFile(new URL('../src/client/ball.ts', import.meta.url), 'utf8')
  const applyLayout = source.slice(source.indexOf('const applyLayout'), source.indexOf('React.useEffect(() => {\n    const stored'))
  assert.ok(applyLayout.length > 300, 'applyLayout 切片必须非空（空切片会让断言空转）')

  // 关闭吸附时必须显式清 attachment，否则球继续粘在线上
  assert.match(applyLayout, /if \(!\(snapDistance > 0\)\) attachment\.current = \{\}/,
    '关闭吸附时必须清掉 attachment.current —— 否则已粘住的球会继续被重新钉回线上')
})

test('F-019：边界值与默认值', async () => {
  const { snapPosition } = loadClient().__test__
  // 默认距离 16
  assert.equal(snapPosition({ x: 105, y: 300 }, targets).position.x, 100,
    '不传距离时必须用默认 16px')

  // 负数/NaN 视同关闭（防御：设置被污染时不至于乱吸）
  for (const bad of [-1, Number.NaN]) {
    const result = snapPosition({ x: 100, y: 50 }, targets, bad)
    assert.equal(result.attachment.x, undefined, `距离=${bad} 时必须视同关闭`)
  }
})

test('F-019：设置贯穿 Host schema / 设置页 / 客户端三层', async () => {
  const config = await readFile(new URL('../src/host/config.ts', import.meta.url), 'utf8')
  assert.match(config, /snapDistance: z\.number\(\)\.min\(SNAP_DISTANCE_MIN\)\.max\(SNAP_DISTANCE_MAX\)/,
    'Host schema 必须有 snapDistance，范围由常量定')
  assert.match(config, /SNAP_DISTANCE_MIN = 0/, '下限必须是 0（0 = 关闭）')
  assert.match(config, /SNAP_DISTANCE_MAX = 48/, '上限必须是 48')
  assert.match(config, /snapDistance: Volatile<number \| undefined>/, 'TaskballConfig 接口必须有')
  assert.match(config, /snapDistance: createVolatile/, 'defaultConfig 必须有默认值')

  const settings = await readFile(new URL('../src/client/settings.ts', import.meta.url), 'utf8')
  assert.match(settings, /field: 'snapDistance'/, '设置页必须登记 snapDistance')
  assert.match(settings, /min: 0,/, '设置页的控件下限必须是 0')

  const index = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // 关键：0 是合法值，不能写成 `?? 16` 把 0 当成缺失
  assert.match(index, /typeof settings\.snapDistance === 'number' \? settings\.snapDistance : SNAP_DISTANCE/,
    '客户端必须只在 undefined 时回落 —— 用 ?? 会把合法的 0 吞掉')
  assert.equal(/settings\.snapDistance \?\? SNAP_DISTANCE/.test(index), false,
    '不得用 ?? 读这个值：0 是「关闭」，不是「没设置」')
})
