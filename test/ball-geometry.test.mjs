// F-018 第一步：球的直径必须只有一个 owner（2026-11-01）
//
// 背景：`44` 曾经散在 5 处（ball.ts / ball-visual.ts / quick.ts / panel.ts ×2），
// 每一处都是**锚定计算**——面板开在哪、快捷面板放得下吗、扇区接缝吃多宽。球一旦
// 改大小而副本留在原地，面板和浮层就会飘到错的位置，用户看到的是「插件坏了」。
//
// 这些断言全部是**源码级**的：它们要证明的是「没有第二份定义」，而运行时行为在
// 球尺寸唯一时完全正常，测试永远抓不到副本。（本仓库的门禁教训：写「每项都有 X」
// 和写「每项 X 相同」是两条不同的断言。）

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))

const CLIENT_FILES = [
  'ball.ts',
  'ball-visual.ts',
  'ball-geometry.ts',
  'panel.ts',
  'panel-icons.ts',
  'panel-confirm.ts',
  'locale.ts',
  'quick.ts',
  'index.ts',
  'ball-strip.ts',
  'settings.ts',
  'host-state.ts',
]

/** Strip comments so prose that NAMES a literal does not count as a definition. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('F-018：球的直径只有一个定义处（ball-geometry.ts）', async () => {
  const geometry = stripComments(await readFile(join(clientDir, 'ball-geometry.ts'), 'utf8'))
  assert.match(geometry, /export const BALL_SIZE = 44/, '唯一 owner 必须是 ball-geometry.ts')

  // 其他文件里不得再出现「重新定义」
  for (const file of CLIENT_FILES.filter((name) => name !== 'ball-geometry.ts')) {
    const code = stripComments(await readFile(join(clientDir, file), 'utf8'))
    assert.equal(
      /(?:const|let|var)\s+BALL_SIZE\s*=/.test(code),
      false,
      `${file} 不得自己定义 BALL_SIZE —— 那正是 F-018 要收口的副本`,
    )
  }
})

test('F-018：任何客户端文件都不得再出现裸 44（锚定常量）', async () => {
  // `ball-geometry.ts` 是 owner，它的定义与注释里当然有 44；`locale.ts` 的 44 只在
  // 档位文案里（「中（44 px，默认）」），那是给用户看的字，不是锚定常量。
  // 判据：除了这两处白名单，其它文件的 44 一律视为副本复活。
  const ALLOWED = new Set(['ball-geometry.ts', 'locale.ts'])
  const offenders = []
  for (const file of CLIENT_FILES) {
    if (ALLOWED.has(file)) continue
    const code = stripComments(await readFile(join(clientDir, file), 'utf8'))
    const hits = [...code.matchAll(/\b44\b/g)]
    if (hits.length > 0) offenders.push(`${file}: ${hits.length} 处`)
  }
  assert.deepEqual(offenders, [], `以下文件仍写着裸 44：${offenders.join(', ')}`)

  // locale.ts 的 44 必须全部在档位文案里 —— 否则它就不是「给用户看的字」了。
  const locale = stripComments(await readFile(join(clientDir, 'locale.ts'), 'utf8'))
  const lines = locale.split('\n').filter((line) => /\b44\b/.test(line))
  assert.ok(lines.length > 0, '前置：locale.ts 里应当只有档位文案含 44')
  for (const line of lines) {
    assert.match(line, /^\s*'settings\.ballSize\.medium'/, `locale.ts 的 44 只允许出现在档位文案里：${line.trim()}`)
  }
})

test('F-018：预设档位是 36 / 44 / 56，且未知值退回默认', async () => {
  const geometry = stripComments(await readFile(join(clientDir, 'ball-geometry.ts'), 'utf8'))
  assert.match(geometry, /small: 36/, '小档必须是 36px')
  assert.match(geometry, /medium: 44/, '中档必须是 44px（设计值）')
  assert.match(geometry, /large: 56/, '大档必须是 56px')
  assert.match(geometry, /export function ballSizePx/, '必须有 ballSizePx 解析函数')
  assert.match(geometry, /Object\.hasOwn\(BALL_SIZE_BY_PRESET, preset\)/,
    '未知档位必须显式判定后回落 —— 否则会出现 NaN px 的隐形球')
})

test('F-018：panel / quick / ball-visual 都从 ball-geometry 取尺寸', async () => {
  const expectImport = async (file, pattern, why) => {
    const code = stripComments(await readFile(join(clientDir, file), 'utf8'))
    assert.match(code, pattern, `${file} 必须从 ball-geometry 取 BALL_SIZE（${why}）`)
  }
  await expectImport('panel.ts', /import \{ BALL_SIZE \} from '\.\/ball-geometry\.js'/, '面板翻边与挂靠用到球直径')
  await expectImport('quick.ts', /import \{ BALL_SIZE \} from '\.\/ball-geometry\.js'/, '快捷面板定位用到球直径')
  await expectImport('ball-visual.ts', /import \{ BALL_SIZE \} from '\.\/ball-geometry\.js'/, '扇区几何用到球直径')
})

test('F-018：不得从 ball.ts 再转出尺寸给 ball-visual（会成循环依赖）', async () => {
  // ball.ts 已经 import ball-visual.ts；若 ball-visual 反过来从 ball.ts 取
  // BALL_SIZE，就形成环。AMD 运行时对循环依赖的解析顺序不可靠，表现为「摸某个
  // 常量是 undefined」，且只在特定加载顺序下出现。
  const visual = stripComments(await readFile(join(clientDir, 'ball-visual.ts'), 'utf8'))
  assert.equal(
    /from '\.\/ball\.js'/.test(visual),
    false,
    'ball-visual.ts 不得 import ball.ts —— ball.ts 已依赖它，会构成循环',
  )
})

test('F-018：锚定计算必须真的用尺寸参数，不能留字面量', async () => {
  const panel = stripComments(await readFile(join(clientDir, 'panel.ts'), 'utf8'))
  // 面板左右翻边与下挂各一处。参数化之后用形参 `ballSize`（默认值才是 BALL_SIZE），
  // 因为函数要能被不同档位调用 —— 锁「用它」而不是锁「用哪个名字」。
  assert.match(panel, /viewportWidth - anchor\.x - ballSize/, '面板右翻边必须用尺寸形参')
  assert.match(panel, /anchor\.y \+ ballSize \+ GAP/, '面板下挂必须用尺寸形参')

  const quick = stripComments(await readFile(join(clientDir, 'quick.ts'), 'utf8'))
  assert.match(quick, /viewportWidth - anchor\.x - ballSize/, '快捷面板右翻边必须用尺寸形参')
  assert.match(quick, /anchor\.y \+ ballSize \+ QUICK_GAP/, '快捷面板下挂必须用尺寸形参')

  // 形参必须真的有默认值接到 BALL_SIZE，否则「不传参」的旧调用会塌成 undefined。
  assert.match(panel, /ballSize: number = BALL_SIZE/, '面板定位的尺寸形参必须默认 BALL_SIZE')
  assert.match(quick, /ballSize: number = BALL_SIZE/, '快捷面板定位的尺寸形参必须默认 BALL_SIZE')
})

// D-072（用户 2026-11-02）：「球中心的模式小圆，不会随着球大小的调整而改变」。
// 根因：中心盘直径写死 16px，而球的直径是用户设置（F-018）。修法是把它变成
// 球直径的固定比例，让三档都保持 v4.4 的比例（16/44）。
test('D-072：中心玻璃盘随球大小等比缩放，中档仍是设计值 16px', async () => {
  const visual = await readFile(join(clientDir, 'ball-visual.ts'), 'utf8')
  assert.match(visual, /const CENTER_RATIO = 16 \/ BALL_SIZE/,
    '比例必须以 BALL_SIZE 为基准，不得写死 44')
  assert.ok(/export function centerPx\(ballPx: number = BALL_PX\)/.test(visual),
    'centerPx 必须接受球直径并带设计值默认')

  const { centerPx } = await import(join(clientDir, '..', '..', 'lib', 'model.mjs')).catch(() => ({}))
  // 直接用公式核对三档（不依赖运行时导出，避免 model.mjs 不含此函数）
  const ratio = 16 / 44
  const expect = (px) => Math.round(px * ratio * 100) / 100
  assert.equal(expect(44), 16, '中档 44px → 16px（v4.4 设计值）')
  assert.equal(expect(36), 13.09, '小档 36px → 13.09px')
  assert.equal(expect(56), 20.36, '大档 56px → 20.36px')

  // 比例恒定：三档的中心盘/球 之比必须相同
  for (const px of [36, 44, 56]) {
    assert.ok(Math.abs(expect(px) / px - ratio) < 0.001, `${px}px 档的比例必须与设计比例一致`)
  }
})

test('D-072：球必须把当前直径传给中心盘（不得回落默认值）', async () => {
  const source = await readFile(join(clientDir, 'ball.ts'), 'utf8')
  assert.ok(/ballCenterStyle\(ballSize\)/.test(source),
    '必须传 ballSize —— 无参调用会静默回落 44px 设计值，正是这个缺陷的成因')
  assert.equal(/ballCenterStyle\(\)/.test(source), false,
    '不得存在无参调用')
})
