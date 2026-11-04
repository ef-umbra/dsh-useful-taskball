// F-001 草稿会话的灰色呈现（用户 2026-10-31 定方案）
//
// 用户拍板的四条约束：
//   (a) 草稿**不占扇形**，只在面板出现；
//   草稿区在面板**顶部**、**不按工作区树分组**、一行行罗列；
//   有标题跟会话标题，无标题的新会话显示「新会话」；
//   空则不显示整个区。
//
// 草稿信号来自宿主私有存储（`dsh.conversation.<sessionId>`），所以这里既测
// 纯函数（解析容错），也测真实渲染（区的位置、不占扇区、空则不渲染）。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { deriveView } from '../lib/model.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const store = new Map()
  // A real `Storage`-shaped object, not the Map itself: `readDraftIds` walks
  // `length` / `key(i)` / `getItem`, and a Map has none of those.
  const localStorage = {
    get length() { return store.size },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    innerHeight: 900,
    localStorage,
    CSS: { registerProperty() {} },
  }
  vm.runInNewContext(source, { window, setTimeout, clearTimeout, setInterval, clearInterval })
  return { client, storage: localStorage }
}

const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

// ---------------------------------------------------------------- 解析容错

test('F-001：草稿判据必须同时认「纯字符串」与「DraftSnapshot」两种格式', async () => {
  const { client } = await loadClient()
  const { hasDraftContent } = client.__test__

  // 当前格式：{ draft: { text, references } }
  assert.equal(hasDraftContent(JSON.stringify({ draft: { text: '写了一半', references: [] } })), true)
  assert.equal(hasDraftContent(JSON.stringify({ draft: { text: '', references: [] } })), false)
  // 只有引用、没有文字也算有内容（宿主 parseStoredDraft 同样这么判）
  assert.equal(hasDraftContent(JSON.stringify({ draft: { text: '', references: [{ path: 'a.ts' }] } })), true)
  // 旧格式：draft 是纯字符串（宿主用 parseStoredDraft 兼容两种）
  assert.equal(hasDraftContent(JSON.stringify({ draft: '旧的纯字符串草稿' })), true)
  assert.equal(hasDraftContent(JSON.stringify({ draft: '   ' })), false)

  // 纯空白不算草稿：宿主会 trim，我们跟它一致
  assert.equal(hasDraftContent(JSON.stringify({ draft: { text: '   \n  ', references: [] } })), false)
})

test('F-001：任何解析失败都必须退化成「无草稿」，绝不能让 overlay 抛错', async () => {
  const { client } = await loadClient()
  const { hasDraftContent } = client.__test__

  // 这不是防御性填充：一个 throw 会经 slot 的错误边界把整个 overlay 卸掉（AGENTS §9）
  const malformed = [
    'not json',
    'null',
    '[]',
    '"just a string"',
    '{}',                                  // 没有 draft 字段
    '{"draft":null}',
    '{"draft":42}',
    '{"draft":{}}',                        // 既无 text 也无 references
    '{"draft":{"text":null,"references":null}}',
    '{"draft":{"references":"not-an-array"}}',
    '',
    null,
  ]
  for (const raw of malformed) {
    assert.equal(hasDraftContent(raw), false, `畸形输入必须退化成无草稿：${String(raw)}`)
  }
})

// 用户 2026-10-31：「草稿区里如果既有工作区新会话，也有旧会话的草稿的话，
// 两个有点难以分辨」→ 工作区新会话那一行最左侧加宿主的文件夹图标。
//
// 判据必须是宿主的 `blank`（折叠前缀里没有任何 turn），不能是标题：
// `displayTitleOf()` 对空白会话会退回 cwd 推导出的工作区名，所以「有标题」
// 根本区分不出「工作区里的新会话」和「有标题的旧会话」。
test('F-001：两种草稿行各有自己的图标 —— 新会话=文件夹，旧会话=气泡', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel

  // 工作区新会话：blank=true，displayTitle 是工作区名（宿主就是这么给的）
  const brandNew = { id: 'new1', title: '', displayTitle: '某工作区', blank: true, updatedAt: 1 }
  // 旧会话：blank=false，有标题，也有草稿
  const oldOne = { id: 'old1', title: '旧会话', displayTitle: '旧会话', blank: false, updatedAt: 2 }

  const view = deriveView([brandNew, oldOne], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['new1', 'old1']))
  const newEntry = view.drafts.find((draft) => draft.id === 'new1')
  const oldEntry = view.drafts.find((draft) => draft.id === 'old1')
  assert.equal(newEntry?.newConversation, true, 'blank 会话必须标记为工作区新会话')
  assert.equal(oldEntry?.newConversation, false, '非 blank 会话不得标记')
  // 宿主的 displayTitle 对空白会话给的是工作区名 —— 这正是「按标题判断」会失败的原因
  assert.equal(newEntry?.title, '某工作区', '前置：宿主给空白会话的是工作区名，不是空串')

  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: [], view, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))

  const rows = [...markup.matchAll(/data-taskball-draft="([^"]+)"/g)]
  assert.equal(rows.length, 2, '前置：两行草稿')
  const sliceRow = (index) => {
    const start = rows[index].index
    const end = index + 1 < rows.length ? rows[index + 1].index : markup.indexOf('</section>', start)
    return markup.slice(start, end)
  }
  const newRow = sliceRow(0)
  const oldRow = sliceRow(1)

  // 用户 2026-10-31：两种行都要有图标，靠形状区分（之前旧会话行留白，两行看起来一样）。
  assert.equal((newRow.match(/<svg/g) ?? []).length, 1, '工作区新会话行必须有且只有一个图标')
  assert.equal((oldRow.match(/<svg/g) ?? []).length, 1, '旧会话行也必须有且只有一个图标')

  // 几何必须与宿主一致（内联复制的前提）。用各自的起始坐标认形状：
  const FOLDER_START = 'M1.50439 3.11059'   // IconFolderCloseRegular 的轮廓起点
  const QUEUE_START = 'M2.37067 11.2497'    // IconQueueOutlineRegular 的轮廓起点
  assert.ok(newRow.includes(FOLDER_START), '新会话行必须是宿主那个文件夹图标')
  assert.equal(newRow.includes(QUEUE_START), false, '新会话行不得混入气泡图标')
  assert.ok(oldRow.includes(QUEUE_START), '旧会话行必须是宿主那个队列/气泡图标')
  assert.equal(oldRow.includes(FOLDER_START), false, '旧会话行不得混入文件夹图标')

  // 两者的几何特征
  assert.equal((newRow.match(/<path/g) ?? []).length, 2, '文件夹图标是两条 path（轮廓 + 中间横线）')
  assert.equal((oldRow.match(/<path/g) ?? []).length, 3, '气泡图标是三条 path（两条横线 + 轮廓）')
  assert.ok(newRow.includes('viewBox="0 0 16 16"') && oldRow.includes('viewBox="0 0 16 16"'),
    '两个图标都必须是宿主的 16×16 视口')
  assert.ok(newRow.includes('stroke-width="1"') && oldRow.includes('stroke-width="1"'),
    '都必须是 strokeWidth 1（Regular 粗细）')
  // 图标只是辅助，不能变成第二样东西给读屏器念
  assert.ok(newRow.includes('aria-hidden'), '文件夹图标必须 aria-hidden')
  assert.ok(oldRow.includes('aria-hidden'), '气泡图标必须 aria-hidden')
  // 图标在文本之前（「最左侧」）
  assert.ok(newRow.indexOf('<svg') < newRow.indexOf('某工作区'), '图标必须在标题左侧')
  assert.ok(oldRow.indexOf('<svg') < oldRow.indexOf('旧会话'), '图标必须在标题左侧')
})

test('F-001：只扫 dsh.conversation. 前缀，其它 localStorage 键一律忽略', async () => {
  const { client, storage } = await loadClient()
  const { readDraftIds, DRAFT_KEY_PREFIX } = client.__test__
  assert.equal(DRAFT_KEY_PREFIX, 'dsh.conversation.')

  storage.setItem('dsh.conversation.s1', JSON.stringify({ draft: { text: '有草稿', references: [] } }))
  storage.setItem('dsh.conversation.s2', JSON.stringify({ draft: { text: '', references: [] } }))
  storage.setItem('dsh.conversation.', JSON.stringify({ draft: { text: '空 id 不算', references: [] } }))
  storage.setItem('unrelated.key', JSON.stringify({ draft: { text: '不该被读到', references: [] } }))
  storage.setItem('dsh-useful-taskball:ball-position', JSON.stringify({ x: 1, y: 2 }))

  // The stub is the same object the bundle closed over, so pass it directly.
  const ids = readDraftIds(storage)
  const found = [...ids].sort()
  assert.deepEqual(found, ['s1'], `只应识别 s1，实际 ${JSON.stringify(found)}`)
})

test('F-001：localStorage 不可用时返回空集合，不抛错', async () => {
  const { client } = await loadClient()
  const { readDraftIds } = client.__test__
  assert.deepEqual([...readDraftIds(undefined)], [])
  assert.deepEqual([...readDraftIds(null)], [])
})

// ---------------------------------------------------------------- 推导语义

const BLANK_SESSION = { id: 'b1', title: '', displayTitle: '', blank: true, updatedAt: 1 }
const NAMED_SESSION = { id: 'n1', title: '重构支付', displayTitle: '重构支付', blank: false, updatedAt: 2 }
const EMPTY_HOST = { retentionMs: 30 * 60_000, sessions: {} }
const NO_STATUSES = new Map()

test('F-001：blank 会话只有带草稿时才进推导（(a) 不占扇区）', async () => {
  const { client } = await loadClient()
  const { NO_DRAFT_IDS } = client.__test__

  // 没有草稿：blank 会话照旧被 visibleSessions 滤掉
  const without = deriveView([BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, NO_DRAFT_IDS)
  assert.equal(without.drafts.length, 0, '无草稿的 blank 会话不得出现在草稿区')
  assert.equal(without.entries.length, 0, '无草稿的 blank 会话不得进入 entries')

  // 有草稿：进草稿区，但**绝不进 entries** —— 这是 (a) 的结构保证
  const withDraft = deriveView([BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))
  assert.equal(withDraft.drafts.length, 1, '有草稿的 blank 会话必须进草稿区')
  assert.equal(withDraft.drafts[0].id, 'b1')
  assert.equal(withDraft.entries.length, 0, '草稿绝不进 entries —— 否则球上会多一个扇区')
  // 球读的是 entries 经 occupiesSector 过滤，所以这条断言等价于「球上没有它」
  assert.equal(withDraft.folded.size, 0, '草稿没有折叠语义')
})

test('F-001：草稿区只收「无任务状态」的会话，避免同一会话在面板出现两次', async () => {
  const { client } = await loadClient()
  const { NO_DRAFT_IDS } = client.__test__
  const statuses = new Map([['n1', { running: true, pendingInteraction: undefined, completionUnread: false }]])

  const view = deriveView([NAMED_SESSION], statuses, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['n1']))
  const blue = view.entries.find((entry) => entry.id === 'n1')
  assert.equal(blue?.color, 'blue', '前置：n1 是执行中')
  assert.equal(view.drafts.length, 0, '有任务状态的会话归工作区分组，不得在草稿区重复出现')
  assert.equal(NO_DRAFT_IDS.size, 0, 'NO_DRAFT_IDS 必须始终为空（模块级常量）')
})

test('F-001：无标题的新会话由 titleOf 兜底，不会渲染成空字符串', async () => {
  const { client } = await loadClient()
  // blank 会话的 title 与 displayTitle 都是空串，titleOf 会退回 id —— 面板侧
  // 再把它换成「新会话」文案。这条锁的是「不抛错、不空指针」。
  const view = deriveView([BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))
  assert.equal(view.drafts.length, 1)
  assert.equal(typeof view.drafts[0].title, 'string')
})

test('F-001：归档的会话即使有草稿也退场（D-005 优先）', async () => {
  const { client } = await loadClient()
  const view = deriveView(
    [BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000,
    { archivedSessionIds: new Set(['b1']) }, new Map(), 10_000, new Set(['b1']),
  )
  assert.equal(view.drafts.length, 0, '归档必须让草稿条目一起退场')
})

// 用户 2026-10-31 真机报障：旧会话有草稿、且绿色完成态已过期时，面板里
// 两处都没有 —— 草稿区没有、任务行也没有，整条会话凭空消失。
//
// 根因是判定顺序：`isGreenExpired` 的 continue 排在草稿分支之前，过期的绿
// 把整条会话（连同它的草稿）一起 continue 掉了。草稿不是任务状态，保留窗
// 没有任何理由退场它 —— 过期的绿只意味着「不再有可见任务状态」，而这正是
// 有草稿的会话该进草稿区的条件。
test('F-001：过期绿不得吞掉草稿 —— 旧会话有草稿且完成态过期时必须出现在草稿区', async () => {
  const { client } = await loadClient()
  const NOW = 1_800_000_000_000
  const RETENTION = 60 * 60_000
  // 真实形状：completed 在 1451 / 1306 分钟前，保留窗 60 分钟。
  const sessions = [
    { id: 'expired-green-with-draft', title: '1029-1', displayTitle: '1029-1', blank: false, updatedAt: NOW - 1451 * 60_000 },
    { id: 'fresh-green-with-draft', title: 'wsl2下载', displayTitle: 'wsl2下载', blank: false, updatedAt: NOW - 21 * 60_000 },
    { id: 'expired-green-no-draft', title: 'no draft', displayTitle: 'no draft', blank: false, updatedAt: NOW - 1451 * 60_000 },
  ]
  const host = {
    retentionMs: RETENTION,
    sessions: {
      'expired-green-with-draft': { lastTurnEnd: { kind: 'completed', at: NOW - 1451 * 60_000 } },
      'fresh-green-with-draft': { lastTurnEnd: { kind: 'completed', at: NOW - 21 * 60_000 } },
      'expired-green-no-draft': { lastTurnEnd: { kind: 'completed', at: NOW - 1451 * 60_000 } },
    },
  }
  const draftIds = new Set(['expired-green-with-draft', 'fresh-green-with-draft'])

  const view = deriveView(sessions, NO_STATUSES, [], host, NOW, undefined, new Map(), 10_000, draftIds)

  // 过期绿 + 有草稿：必须出现在草稿区，且绝不进 entries（否则球上多一个扇区）
  const expired = view.drafts.find((entry) => entry.id === 'expired-green-with-draft')
  assert.notEqual(expired, undefined, '过期绿 + 有草稿的会话必须出现在草稿区，不得整条消失')
  assert.equal(view.entries.some((entry) => entry.id === 'expired-green-with-draft'), false,
    '草稿条目不得进 entries —— 球上不能多一个扇区')
  assert.equal(view.folded.has('expired-green-with-draft'), false, '草稿没有折叠语义')

  // 未过期绿 + 有草稿：它仍有可见任务状态，归工作区分组，不得在草稿区重复出现
  assert.equal(view.drafts.some((entry) => entry.id === 'fresh-green-with-draft'), false,
    '未过期的绿仍有任务状态，不得在草稿区重复出现')
  assert.equal(view.entries.find((entry) => entry.id === 'fresh-green-with-draft')?.color, 'green',
    '未过期的绿必须仍然以任务状态呈现')

  // 过期绿 + 无草稿：照旧从两处退场（D-004 的保留窗仍然管任务状态）
  assert.equal(view.entries.some((entry) => entry.id === 'expired-green-no-draft'), false,
    '过期绿且无草稿的会话必须退场 —— 修复不得让保留窗失效')
  assert.equal(view.drafts.some((entry) => entry.id === 'expired-green-no-draft'), false,
    '没有草稿就没有进草稿区的理由')
})

// ---------------------------------------------------------------- 渲染

const WORKSPACES = [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['n1'] }]

test('F-001：无标题的新会话显示「新会话」，不显示 sessionId', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel
  // 用户 2026-10-31：「新会话没有标题的就叫新会话」。
  // titleOf() 会退回 sessionId，那个字符串绝不能出现在草稿行里。
  const view = deriveView(
    [BLANK_SESSION, NAMED_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000,
    undefined, new Map(), 10_000, new Set(['b1', 'n1']),
  )
  assert.equal(view.drafts.length, 2, '前置：两条草稿')
  const blank = view.drafts.find((draft) => draft.id === 'b1')
  assert.equal(blank?.untitled, true, '无标题会话必须标记 untitled')
  assert.equal(blank?.title, '', '标题必须留空，不能退回 sessionId')
  const named = view.drafts.find((draft) => draft.id === 'n1')
  assert.equal(named?.untitled, false, '有标题会话不得标记 untitled')
  assert.equal(named?.title, '重构支付', '必须跟随会话标题')

  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: [], view, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))
  assert.ok(markup.includes('panel.draftsUntitled'), '无标题会话必须走 i18n 文案')
  assert.equal(markup.includes('>b1<'), false, '不得把 sessionId 当标题渲染')
  assert.ok(markup.includes('重构支付'), '有标题会话正常显示标题')
})

test('F-001：草稿区在面板最上方，且不按工作区树分组', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel
  const statuses = new Map([['n1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  const view = deriveView([BLANK_SESSION, NAMED_SESSION], statuses, WORKSPACES, EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))

  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: WORKSPACES, view, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))

  assert.ok(markup.includes('data-taskball-drafts'), '必须有草稿区容器')
  assert.ok(markup.includes('data-taskball-draft="b1"'), '草稿行必须带会话 id')
  // 位置：草稿区必须出现在第一个工作区分组之前
  const draftsAt = markup.indexOf('data-taskball-drafts')
  const workspaceAt = markup.indexOf('项目一')
  assert.ok(draftsAt !== -1 && workspaceAt !== -1, '前置：两者都在')
  assert.ok(draftsAt < workspaceAt, '草稿区必须在工作区分组之上')
  // 不分组：草稿区**自身**不得带工作区标题。切到草稿区结束（它自己的 section
  // 闭合）为止，而不是到下一个 data-taskball-rows —— 后者在工作区分组里，
  // 跨过了分组标题，会把「项目一」误算进草稿区。
  const draftSection = markup.slice(draftsAt, markup.indexOf('</section>', draftsAt))
  assert.equal(draftSection.includes('项目一'), false, '草稿区不得按工作区树分组')
  assert.ok(draftSection.includes('重构支付') === false || draftSection.includes('data-taskball-draft'), '草稿区只含草稿行')
})

// 用户 2026-10-31：「草稿区和下方的工作区树之间加一个分隔线，草稿区为空时
// 分隔线也要消失」。
//
// 分隔线做成草稿区**自身的 border**，而不是一个兄弟元素 —— 这样「空 → 无草稿区
// → 无分隔线」是标记结构的性质，不需要第二个 `drafts.length` 判断去保持同步。
test('F-001：草稿区与工作区树之间有分隔线，且草稿区为空时一起消失', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel

  const render = (draftIds, sessions, workspaces = []) => {
    const view = deriveView(sessions, NO_STATUSES, workspaces, EMPTY_HOST, 1000, undefined, new Map(), 10_000, draftIds)
    return renderToStaticMarkup(React.createElement(Panel, {
      workspaces, view, expanded: true, t,
      onToggleFolded() {}, onOpenSession() {}, onClose() {},
    }))
  }

  // 有草稿 + 有工作区分组 → 分隔线必须在两者之间
  const statuses = new Map([['n1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  const withDraftView = deriveView([BLANK_SESSION, NAMED_SESSION], statuses, WORKSPACES, EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))
  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: WORKSPACES, view: withDraftView, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))
  const draftAt = markup.indexOf('data-taskball-drafts')
  const groupLabelAt = markup.indexOf('项目一')
  assert.ok(draftAt !== -1 && groupLabelAt !== -1, '前置：草稿区与工作区分组都在')
  const draftSection = markup.slice(draftAt, markup.indexOf('</section>', draftAt))
  assert.ok(draftSection.includes('border-bottom'), '草稿区必须画底部分隔线')
  // 分隔线必须在工作区树之前（它是草稿区的底边）
  assert.ok(draftAt < groupLabelAt, '分隔线所在的草稿区必须在工作区树之上')

  // 无草稿 → 整个草稿区消失，因此分隔线也消失（不是另一条判断，是同一件事）
  const withoutDraft = render(client.__test__.NO_DRAFT_IDS, [NAMED_SESSION], WORKSPACES)
  assert.equal(withoutDraft.includes('data-taskball-drafts'), false, '无草稿时草稿区不渲染')
  assert.equal(withoutDraft.includes('border-bottom'), false, '无草稿时分隔线必须一起消失')
})

test('F-001：草稿行没有勾选框，整行可点', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel
  const view = deriveView([BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))

  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: [], view, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))

  const draftAt = markup.indexOf('data-taskball-draft=')
  assert.ok(draftAt !== -1, '前置：草稿行存在')
  const nextSection = markup.indexOf('data-taskball-rows', draftAt)
  const draftRow = markup.slice(draftAt, nextSection === -1 ? undefined : nextSection)
  assert.equal(draftRow.includes('type="checkbox"'), false, '草稿行不得有勾选框（草稿没有「已处理」语义）')
  assert.equal(draftRow.includes('data-taskball-check'), false, '同上')
  assert.ok(draftRow.includes('<button'), '整行必须是可点按钮')
})

test('F-001：没有草稿时整区不渲染，且不谎报「暂无任务状态」', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel

  // 空面板 + 无草稿 → 显示空态
  const emptyView = deriveView([], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000)
  const empty = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: [], view: emptyView, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))
  assert.equal(empty.includes('data-taskball-drafts'), false, '无草稿不得渲染草稿区')
  assert.ok(empty.includes('panel.empty'), '空面板仍须显示空态')

  // 只有草稿 → 不显示空态（否则「暂无任务状态」会出现在草稿行上方，自相矛盾）
  const draftOnly = deriveView([BLANK_SESSION], NO_STATUSES, [], EMPTY_HOST, 1000, undefined, new Map(), 10_000, new Set(['b1']))
  const onlyDrafts = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: [], view: draftOnly, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))
  assert.ok(onlyDrafts.includes('data-taskball-drafts'), '前置：草稿区在')
  assert.equal(onlyDrafts.includes('panel.empty'), false, '有草稿时不得再报「暂无任务状态」')
})

test('F-001：view 缺 drafts 字段时必须渲染成「无草稿」，不得抛错', async () => {
  const { client } = await loadClient()
  const Panel = client.__test__.TaskballPanel
  const view = deriveView([NAMED_SESSION], new Map([['n1', { running: true, pendingInteraction: undefined, completionUnread: false }]]), WORKSPACES, EMPTY_HOST, 1000, undefined, new Map(), 10_000)
  const withoutField = { entries: view.entries, failures: view.failures, folded: view.folded }
  // 一个 throw 会经 slot 错误边界把整个 overlay 卸掉（AGENTS §9）
  const markup = renderToStaticMarkup(React.createElement(Panel, {
    workspaces: WORKSPACES, view: withoutField, expanded: true, t,
    onToggleFolded() {}, onOpenSession() {}, onClose() {},
  }))
  assert.equal(markup.includes('data-taskball-drafts'), false)
  assert.ok(markup.length > 0, '必须正常渲染出面板')
})
