// 面板 DOM 身份稳定性回归（2026-10-30 用户报障）
//
// 三个问题里有两个是「静态 HTML 看起来对、真实 DOM 行为不对」，静态渲染断言
// （renderToStaticMarkup）抓不到：
//
// 1. 撤销勾选后「已处理」区自行收起 —— 静态 HTML 每帧都对，错的是**节点身份**：
//    `<details>` 的展开态是 DOM 状态，React 一旦卸载重挂就丢。所以必须用真实
//    createRoot 渲染，跨两帧比较节点引用。
// 2. Shift+勾绿的批量路径 —— 要调真实 fiber 上的 onClick/onChange 才能证明
//    「点了真的会发生」，而不是「源码里写了这段字符串」。
//
// 最小 DOM 桩 + 从 fiber 取 props 处理器，是本仓库已验证的写法
// （见 docs/testing-manual.md §26「验证方式的分工」）。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { deriveView } from '../lib/model.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { act } = require('react-dom/test-utils')

/** The smallest DOM React 18 can mount into; enough for panels and rows. */
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

const windowStub = {
  document: documentStub,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem() {} },
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

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const loaderWindow = {
    ...windowStub,
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
  }
  vm.runInNewContext(source, {
    window: loaderWindow,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  return client
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

function walk(node, visit) {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findAll(container, predicate) {
  const found = []
  walk(container, (node) => { if (node.nodeType === 1 && predicate(node)) found.push(node) })
  return found
}

/** The React props of a rendered element, reachable only through its fiber. */
function fiberProps(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  return key === undefined ? undefined : node[key]
}

function mount(element) {
  const container = documentStub.createElement('div')
  documentStub.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  return { container, root }
}

const GREEN_SESSIONS = [
  { id: 'g1', title: '写周报', displayTitle: '写周报', blank: false, updatedAt: 1 },
  { id: 'g2', title: '整理资料', displayTitle: '整理资料', blank: false, updatedAt: 2 },
]
const GREEN_STATUSES = new Map([
  ['g1', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ['g2', { running: false, pendingInteraction: undefined, completionUnread: false }],
])
const GREEN_HOST = {
  retentionMs: 30 * 60_000,
  sessions: {
    g1: { lastTurnEnd: { kind: 'completed', at: 300 } },
    g2: { lastTurnEnd: { kind: 'completed', at: 400 } },
  },
}
const WORKSPACES = [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['g1', 'g2'] }]

function greenView() {
  return deriveView(GREEN_SESSIONS, GREEN_STATUSES, WORKSPACES, GREEN_HOST, 1000, undefined, new Map(), 10_000)
}

// 用户 2026-10-30 报：「打开展开已处理项时，撤销勾选一个项，未处理项就会自行
// 直接折叠起来」。
//
// 根因不是折叠语义，是 React 的兄弟节点按 INDEX 匹配：分组 <section> 有 key，
// 而它后面的「已处理」<section> 和空态 <div> 都没有。撤销一条后它回到未处理区，
// 若该工作区此前没有未处理条目，就会**在折叠区之前插入一个新分组**，下标整体
// 后移 —— 无 key 的兄弟被按位置错配，<details> 卸载重挂，展开态丢失。
//
// 这条只能靠真实渲染 + 跨帧比较节点身份来锁，静态 HTML 每帧都是对的。
test('bug3：撤销勾选不得让「已处理」区收起（<details> 必须保持同一节点）', async () => {
  const client = await loadClient()
  const Panel = client.__test__.TaskballPanel
  const view = greenView()
  assert.deepEqual(view.entries.map((entry) => entry.color), ['green', 'green'], '前置：两条都必须是绿色')

  const calls = { toggle: [], bulk: [] }
  const props = (folded) => ({
    workspaces: WORKSPACES,
    view: { ...view, folded },
    expanded: true,
    t,
    onToggleFolded: (...args) => calls.toggle.push(args),
    onOpenSession() {},
    onClose() {},
    onBulkFold: (...args) => calls.bulk.push(args),
  })

  const { container, root } = mount()

  // 第 1 帧：两条都在「已处理」，未处理区为空（没有任何工作区分组）
  await act(async () => { root.render(React.createElement(Panel, props(new Set(['g1', 'g2'])))) })
  const detailsBefore = findAll(container, (node) => node.tagName === 'DETAILS')
  assert.equal(detailsBefore.length, 1, '已处理区必须存在')
  // 模拟用户展开：浏览器把 open 写到 DOM 属性上，React 不管这个属性
  detailsBefore[0].setAttribute('open', '')
  assert.equal(detailsBefore[0].getAttribute('open'), '', '前置：已展开')

  // 第 2 帧：撤销 g1 → 它回到未处理区 → 工作区分组出现，排在折叠区之前
  await act(async () => { root.render(React.createElement(Panel, props(new Set(['g2'])))) })
  const detailsAfter = findAll(container, (node) => node.tagName === 'DETAILS')
  const groupsAfter = findAll(container, (node) => node.tagName === 'SECTION')
  assert.equal(detailsAfter.length, 1, '已处理区必须仍在')
  assert.equal(groupsAfter.length, 2, '撤销后必须出现一个工作区分组 + 一个已处理区')

  assert.equal(detailsAfter[0], detailsBefore[0],
    '<details> 必须是同一个 DOM 节点 —— 重新挂载会让浏览器的展开态丢失，这就是用户看到的「自行折叠」')
  assert.equal(detailsAfter[0].getAttribute('open'), '', '展开态必须保留')
  await act(async () => { root.unmount() })
})

// 同一条根因的第二个可观察面：分组数量在两个方向变化时都不能重建折叠区。
test('bug3：分组增减时「已处理」区节点身份稳定（两个方向都测）', async () => {
  const client = await loadClient()
  const Panel = client.__test__.TaskballPanel
  const view = greenView()

  const props = (folded) => ({
    workspaces: WORKSPACES,
    view: { ...view, folded },
    expanded: true,
    t,
    onToggleFolded() {},
    onOpenSession() {},
    onClose() {},
  })

  const { container, root } = mount()

  // 先有分组（只折叠 g2 → g1 在未处理区）
  await act(async () => { root.render(React.createElement(Panel, props(new Set(['g2'])))) })
  const first = findAll(container, (node) => node.tagName === 'DETAILS')[0]
  assert.ok(first !== undefined, '已处理区必须存在')

  // 分组消失（全部折叠）
  await act(async () => { root.render(React.createElement(Panel, props(new Set(['g1', 'g2'])))) })
  const second = findAll(container, (node) => node.tagName === 'DETAILS')[0]
  assert.equal(second, first, '分组消失不得重建已处理区')

  // 分组再出现（撤销一条）
  await act(async () => { root.render(React.createElement(Panel, props(new Set(['g2'])))) })
  const third = findAll(container, (node) => node.tagName === 'DETAILS')[0]
  assert.equal(third, first, '分组再次出现也不得重建已处理区')
  await act(async () => { root.unmount() })
})

// F-013（用户 2026-10-30 要求）：「对绿色状态也加一个按住 Shift 勾选可以全部
// 勾选的功能，且不对绿色做二次确认」。D-006 的二次确认是为红色设的护栏 ——
// 折叠失败会藏起一个还要处理的事实；已完成条目相反：它本来就已完成、会自己过期、
// 且新 turn 会自动撤销折叠，再问一遍只是仪式。
test('F-013：Shift+勾绿 = 一次折叠全部绿色，且不弹二次确认', async () => {
  const client = await loadClient()
  const Panel = client.__test__.TaskballPanel

  const sessions = [
    { id: 'g1', title: '写周报', displayTitle: '写周报', blank: false, updatedAt: 1 },
    { id: 'g2', title: '整理资料', displayTitle: '整理资料', blank: false, updatedAt: 2 },
    { id: 'g3', title: '改稿', displayTitle: '改稿', blank: false, updatedAt: 3 },
    { id: 'r1', title: '重构支付', displayTitle: '重构支付', blank: false, updatedAt: 4 },
  ]
  const statuses = new Map([
    ['g1', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['g2', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['g3', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['r1', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ])
  const host = {
    retentionMs: 30 * 60_000,
    sessions: {
      g1: { lastTurnEnd: { kind: 'completed', at: 300 } },
      g2: { lastTurnEnd: { kind: 'completed', at: 400 } },
      g3: { lastTurnEnd: { kind: 'completed', at: 500 } },
      r1: { lastTurnEnd: { kind: 'error', message: 'boom', at: 600 }, endsSinceCompletion: [{ kind: 'error', message: 'boom', at: 600 }] },
    },
  }
  const workspaces = [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['g1', 'g2', 'g3', 'r1'] }]
  const view = deriveView(sessions, statuses, workspaces, host, 1000, undefined, new Map(), 10_000)
  assert.equal(view.entries.filter((entry) => entry.color === 'green').length, 3, '前置：3 绿')
  assert.equal(view.entries.filter((entry) => entry.color === 'red').length, 1, '前置：1 红')

  const calls = { toggle: [], bulk: [] }
  const { container, root } = mount()
  await act(async () => {
    root.render(React.createElement(Panel, {
      workspaces, view, expanded: true, t,
      onToggleFolded: (...args) => calls.toggle.push(args),
      onOpenSession() {},
      onClose() {},
      onBulkFold: (...args) => calls.bulk.push(args),
    }))
  })

  const greenChecks = findAll(container, (node) => node.getAttribute('data-taskball-check') === 'green')
  assert.equal(greenChecks.length, 3, '渲染出 3 个绿色勾选框')

  // 真实顺序：click 带修饰键（记 shiftHeldRef）→ change 消费
  const props = fiberProps(greenChecks[0])
  await act(async () => {
    props.onClick({ shiftKey: true })
    props.onChange({})
  })

  const dialogs = findAll(container, (node) => node.getAttribute('data-taskball-bulk-confirm') === 'true')
  assert.equal(dialogs.length, 0, '绿色批量不得弹二次确认（用户明确要求）')
  assert.equal(calls.bulk.length, 1, '必须一次 onBulkFold，不要逐条写 Host')
  const [ids, folded] = calls.bulk[0]
  assert.equal(ids.length, 3, `批量范围必须是全部绿色，实际 ${JSON.stringify(ids)}`)
  assert.equal(ids.includes('r1'), false, '不得把红色卷进绿色批量')
  assert.equal(folded, true)
  assert.equal(calls.toggle.length, 0, '批量路径不得退化成逐条 onToggleFolded')

  const leaving = findAll(container, (node) => node.getAttribute('data-taskball-row') !== null
    && node.getAttribute('data-leaving') === 'true')
  assert.equal(leaving.length, 3, '三条绿行必须一起播离场动画')
  await act(async () => { root.unmount() })
})

// 护栏不能因为新增绿色批量而被削弱：红色仍然必须二次确认。
test('F-013 回归：Shift+勾红仍必须弹确认，且弹窗打开时一条都不折叠', async () => {
  const client = await loadClient()
  const Panel = client.__test__.TaskballPanel

  const sessions = [
    { id: 'r1', title: '重构支付', displayTitle: '重构支付', blank: false, updatedAt: 1 },
    { id: 'r2', title: '修复登录', displayTitle: '修复登录', blank: false, updatedAt: 2 },
  ]
  const statuses = new Map([
    ['r1', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['r2', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ])
  const host = {
    retentionMs: 30 * 60_000,
    sessions: {
      r1: { lastTurnEnd: { kind: 'error', message: 'boom', at: 100 }, endsSinceCompletion: [{ kind: 'error', message: 'boom', at: 100 }] },
      r2: { lastTurnEnd: { kind: 'blocked', at: 200 }, endsSinceCompletion: [{ kind: 'blocked', at: 200 }] },
    },
  }
  const workspaces = [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['r1', 'r2'] }]
  const view = deriveView(sessions, statuses, workspaces, host, 1000, undefined, new Map(), 10_000)

  const calls = { toggle: [], bulk: [] }
  const { container, root } = mount()
  await act(async () => {
    root.render(React.createElement(Panel, {
      workspaces, view, expanded: true, t,
      onToggleFolded: (...args) => calls.toggle.push(args),
      onOpenSession() {},
      onClose() {},
      onBulkFold: (...args) => calls.bulk.push(args),
    }))
  })

  const redChecks = findAll(container, (node) => node.getAttribute('data-taskball-check') === 'red')
  const props = fiberProps(redChecks[0])
  await act(async () => {
    props.onClick({ shiftKey: true })
    props.onChange({})
  })

  assert.equal(findAll(container, (node) => node.getAttribute('data-taskball-bulk-confirm') === 'true').length, 1,
    'D-006 的红色护栏必须仍然生效')
  assert.equal(calls.bulk.length + calls.toggle.length, 0, '弹窗打开时一条都不折叠')
  await act(async () => { root.unmount() })
})

// 无 Shift 的普通勾选路径不得被绿色批量逻辑吞掉。
test('F-013 回归：无 Shift 勾绿仍走逐条 onToggleFolded', async () => {
  const client = await loadClient()
  const Panel = client.__test__.TaskballPanel

  const sessions = [{ id: 'g1', title: '写周报', displayTitle: '写周报', blank: false, updatedAt: 1 }]
  const statuses = new Map([['g1', { running: false, pendingInteraction: undefined, completionUnread: true }]])
  const host = { retentionMs: 30 * 60_000, sessions: { g1: { lastTurnEnd: { kind: 'completed', at: 300 } } } }
  const workspaces = [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['g1'] }]
  const view = deriveView(sessions, statuses, workspaces, host, 1000, undefined, new Map(), 10_000)

  const calls = { toggle: [], bulk: [] }
  const { container, root } = mount()
  await act(async () => {
    root.render(React.createElement(Panel, {
      workspaces, view, expanded: true, t,
      onToggleFolded: (...args) => calls.toggle.push(args),
      onOpenSession() {},
      onClose() {},
      onBulkFold: (...args) => calls.bulk.push(args),
    }))
  })

  const greenChecks = findAll(container, (node) => node.getAttribute('data-taskball-check') === 'green')
  const props = fiberProps(greenChecks[0])
  await act(async () => {
    props.onClick({ shiftKey: false })
    props.onChange({})
  })

  assert.equal(calls.toggle.length, 1, '普通勾选必须逐条')
  assert.equal(calls.bulk.length, 0, '普通勾选不得触发批量')
  assert.equal(calls.toggle[0][0], 'g1')
  assert.equal(calls.toggle[0][2], true)
  await act(async () => { root.unmount() })
})
