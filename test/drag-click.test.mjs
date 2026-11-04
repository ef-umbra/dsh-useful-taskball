// 球的「拖拽 vs 点击」判定（2026-11-01 用户报障）
//
// 用户原话：「按住鼠标左键拖动球，然后释放的时候，会打开面板，改一下，长按拖动后
// 释放不要打开任务面板」。
//
// 根因是判定用错了参照系：`moved` 逐帧比较「上一帧位置」，而慢速拖动每帧只挪
// 1–2px，永远不越过 `> 2` 阈值 → 整段拖拽都算「没动」→ 松手走 onToggle 开面板。
// 快速拖动之所以看起来正常，只是因为某一帧恰好跳得够远。
//
// 这类 bug **静态渲染断言抓不到**（HTML 每帧都对），源码字符串断言也只能证明
// 「写了某个条件」，证明不了「慢速拖拽真的不开面板」。所以这里用真实 React 渲染 +
// 合成指针事件跑真正的拖拽序列，两种判据会给出不同结果 —— 这正是要锁住的东西。
//
// DOM 桩沿用 test/panel-dom.test.mjs 已验证的那一套。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { act } = require('react-dom/test-utils')

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.style = {
      setProperty(name, value) { this[name] = value },
      removeProperty(name) { delete this[name] },
      getPropertyValue(name) { return this[name] ?? '' },
    }
    this.listeners = {}
    this.textContent = ''
    this.nodeType = 1
    this.checked = false
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  insertBefore(child, reference) {
    const index = reference === null ? this.children.length : this.children.indexOf(reference)
    child.parentNode = this
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
  removeEventListener(type, listener) {
    const list = this.listeners[type]
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }
  get ownerDocument() { return documentStub }
  get firstChild() { return this.children[0] ?? null }
  querySelector() { return null }
  querySelectorAll() { return [] }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0 } }
  focus() {}
  blur() {}
}

const documentStub = {
  nodeType: 9,
  createElement: (tag) => new StubNode(tag),
  createElementNS: (_namespace, tag) => new StubNode(tag),
  createTextNode: (text) => {
    const node = new StubNode('#text')
    node.nodeType = 3
    node.textContent = text
    return node
  },
  documentElement: new StubNode('html'),
  body: new StubNode('body'),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
}

/**
 * A window that actually dispatches: the ball's drag handlers are registered on
 * `window` (not the element) precisely because an element-scoped listener stops
 * firing once the pointer leaves the ball. A stub that swallows addEventListener
 * would therefore never exercise the real path.
 */
const windowListeners = new Map()
const windowStub = {
  document: documentStub,
  addEventListener(type, listener) {
    const list = windowListeners.get(type) ?? []
    list.push(listener)
    windowListeners.set(type, list)
  },
  removeEventListener(type, listener) {
    const list = windowListeners.get(type)
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  },
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  HTMLIFrameElement: class {},
  Node: StubNode,
  Element: StubNode,
  MutationObserver: class { observe() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Node = StubNode
globalThis.Element = StubNode
globalThis.MutationObserver = windowStub.MutationObserver
globalThis.requestAnimationFrame = (listener) => setTimeout(listener, 16)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const dispatch = (type, event) => {
  for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event)
}

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const loaderWindow = {
    ...windowStub,
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
  }
  vm.runInNewContext(source, {
    window: loaderWindow,
    localStorage: windowStub.localStorage,
    // ⚠ These MUST be on the context itself, not only on `window`: inside
    // `vm.runInNewContext` the code's `globalThis` IS the context object, and the
    // ball reads `globalThis.innerWidth`. Leaving them out made `applyLayout`
    // bail on `width === 0`, so the ball never got a position, `onPointerDown`
    // returned at its first line, and the drag tests "passed" without ever
    // reaching the code under test — a false green (caught 2026-11-01).
    innerWidth: windowStub.innerWidth,
    innerHeight: windowStub.innerHeight,
    addEventListener: windowStub.addEventListener,
    removeEventListener: windowStub.removeEventListener,
    matchMedia: windowStub.matchMedia,
    MutationObserver: windowStub.MutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  return client
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

function fiberProps(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  return key === undefined ? undefined : node[key]
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/**
 * Mount the ball and return a driver that performs a press → N moves → release.
 *
 * `stepPx` is the PER-FRAME displacement, which is the whole point: a slow drag
 * uses 1px steps, a fast one jumps. Both must end up as a drag when the total
 * travel is large.
 */
async function mountBall() {
  const client = await loadClient()
  const Ball = client.__test__.TaskballBall
  let toggles = 0
  const container = documentStub.createElement('div')
  documentStub.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(Ball, {
      entries: [],
      expanded: false,
      folded: new Set(),
      onQuick() {},
      onToggle() { toggles += 1 },
      t,
    }))
  })

  // The ball's own element carries the fiber props (onPointerDown lives there).
  let ball = null
  walk(container, (node) => {
    if (ball === null && node.nodeType === 1 && node.attributes['data-taskball-ball'] === 'true') ball = node
  })
  assert.ok(ball !== null, '必须能定位到球元素（找不到说明 DOM 桩与组件结构脱节）')
  const handlers = fiberProps(ball)
  assert.ok(typeof handlers?.onPointerDown === 'function', '球必须挂 onPointerDown')

  return {
    container,
    async press(x, y, pointerId = 1) {
      await act(async () => {
        handlers.onPointerDown({
          button: 0,
          clientX: x,
          clientY: y,
          pointerId,
          preventDefault() {},
        })
      })
    },
    async moveTo(x, y, pointerId = 1) {
      await act(async () => {
        dispatch('pointermove', { clientX: x, clientY: y, pointerId })
      })
    },
    async release(x, y, pointerId = 1) {
      await act(async () => {
        dispatch('pointerup', { clientX: x, clientY: y, pointerId })
      })
    },
    toggles: () => toggles,
    async unmount() {
      await act(async () => { root.unmount() })
    },
  }
}

test('拖动后释放不得打开面板 —— 慢速拖动（每帧 1px）', async () => {
  const ball = await mountBall()
  // 起点取球中心附近；每帧只挪 1px，累计 40px。旧实现下每帧位移都 ≤ 2，
  // moved 永远为 false，松手会调 onToggle。
  await ball.press(1300, 820)
  for (let step = 1; step <= 40; step += 1) {
    await ball.moveTo(1300 - step, 820 - step)
  }
  await ball.release(1260, 780)

  assert.equal(ball.toggles(), 0, '慢速拖动 40px 后松手不得打开面板（这就是用户报的 bug）')
  await ball.unmount()
})

test('拖动后释放不得打开面板 —— 快速拖动（每帧 30px）', async () => {
  const ball = await mountBall()
  await ball.press(1300, 820)
  await ball.moveTo(1270, 790)
  await ball.moveTo(1240, 760)
  await ball.release(1240, 760)

  assert.equal(ball.toggles(), 0, '快速拖动同样不得打开面板')
  await ball.unmount()
})

test('原地按下再松手仍然算点击，必须打开面板', async () => {
  const ball = await mountBall()
  await ball.press(1300, 820)
  await ball.release(1300, 820)

  assert.equal(ball.toggles(), 1, '不动的按下-释放必须是点击（否则球再也点不开）')
  await ball.unmount()
})

test('手抖 1–3px 仍算点击，超过阈值才算拖动', async () => {
  const client = await loadClient()
  const { DRAG_THRESHOLD_PX } = client.__test__
  assert.equal(DRAG_THRESHOLD_PX, 4, '阈值必须是 4px（平台拖拽 slop 量级）')

  // 抖动在阈值内：算点击。
  const trembling = await mountBall()
  await trembling.press(1300, 820)
  await trembling.moveTo(1302, 821)
  await trembling.moveTo(1303, 822)
  await trembling.release(1303, 822)
  assert.equal(trembling.toggles(), 1, `位移 ≤ ${DRAG_THRESHOLD_PX}px 必须仍算点击，否则轻点会失灵`)
  await trembling.unmount()

  // 越过阈值：算拖动。
  const dragging = await mountBall()
  await dragging.press(1300, 820)
  await dragging.moveTo(1310, 820)
  await dragging.release(1310, 820)
  assert.equal(dragging.toggles(), 0, '位移超过阈值必须是拖动，不得开面板')
  await dragging.unmount()
})

test('判定必须用「相对按下点的累计位移」，不得用帧间位移', async () => {
  // 行为测试已覆盖，这条再锁源码形状：帧间判据的写法是拿 latest.current 比，
  // 而正确写法必须记住按下点 startX/startY。两者在源码里可区分。
  const source = await readFile(new URL('../src/client/ball.ts', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('const onPointerDown'), source.indexOf('const onKeyDown'))
  assert.ok(handler.length > 500, 'onPointerDown 切片必须非空（空切片会让断言空转通过）')
  assert.ok(/const startX = event\.clientX/.test(handler), '必须记下按下点的 x')
  assert.ok(/const startY = event\.clientY/.test(handler), '必须记下按下点的 y')
  assert.ok(/Math\.abs\(moveEvent\.clientX - startX\)/.test(handler), '必须与按下点比较 x')
  assert.ok(/Math\.abs\(moveEvent\.clientY - startY\)/.test(handler), '必须与按下点比较 y')
  assert.equal(/const previous = latest\.current/.test(handler), false,
    '不得再用「上一帧位置」做拖拽判定 —— 慢速拖动每帧位移都低于阈值，永远判不出拖动')
  assert.equal(/Math\.abs\(next\.x - previous\.x\)/.test(handler), false, '同上：不得比帧间位移')
})
