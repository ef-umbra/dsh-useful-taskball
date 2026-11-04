import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FOLD_RECONCILE_MS,
  classifyStatus,
  completedAtOf,
  countByColor,
  deriveView,
  failureOf,
  foldedIds,
  groupByWorkspace,
  isExpired,
  isFailureKind,
  isFoldedNow,
  isGreenExpired,
  occupiesSector,
  overriddenFolds,
  pruneFoldOverrides,
  sectorAngles,
  sectorEntries,
  taskEntries,
  titleOf,
  turnInFlight,
  visibleSessions,
  DEFAULT_POLL_MS,
  EMPTY_WITNESSES,
  flightWindowMs,
  noteRunning,
  pruneWitnesses,
} from '../lib/model.mjs'

const session = (id, overrides = {}) => ({
  id,
  title: `title-${id}`,
  displayTitle: `display-${id}`,
  blank: false,
  updatedAt: 0,
  ...overrides,
})

const status = (overrides = {}) => ({
  running: false,
  pendingInteraction: undefined,
  completionUnread: false,
  ...overrides,
})

const hostState = (sessions = {}, retentionMs = 30 * 60_000) => ({ retentionMs, sessions })

test('五色判定：优先级 红 > 黄 > 蓝 > 绿', () => {
  assert.equal(classifyStatus(undefined, true), 'red')
  assert.equal(classifyStatus(status({
    running: true,
    pendingInteraction: { kind: 'approval' },
    completionUnread: true,
  }), true), 'red')
  assert.equal(classifyStatus(status({
    running: true,
    pendingInteraction: { kind: 'approval' },
    completionUnread: true,
  }), false), 'yellow')
  assert.equal(classifyStatus(status({ running: true, completionUnread: true }), false), 'blue')
  assert.equal(classifyStatus(status({ completionUnread: true }), false), 'green')
  assert.equal(classifyStatus(status(), false), 'gray')
  assert.equal(classifyStatus(undefined, false), 'gray')
})

test('待审批 kind 只认 approval / plan-review / question', () => {
  for (const kind of ['approval', 'plan-review', 'question']) {
    assert.equal(classifyStatus(status({ pendingInteraction: { kind } }), false), 'yellow')
  }
  assert.equal(classifyStatus(status({ pendingInteraction: { kind: 'other' } }), false), 'gray')
})

test('红色判定：aborted 排除 user 与 legacy', () => {
  assert.equal(isFailureKind('error', undefined), true)
  assert.equal(isFailureKind('interrupted', undefined), true)
  assert.equal(isFailureKind('blocked', undefined), true)
  assert.equal(isFailureKind('aborted', 'parent'), true)
  assert.equal(isFailureKind('aborted', 'hook'), true)
  assert.equal(isFailureKind('aborted', 'disposed'), true)
  assert.equal(isFailureKind('aborted', 'user'), false)
  assert.equal(isFailureKind('aborted', 'legacy'), false)
  assert.equal(isFailureKind('aborted', undefined), false)
  assert.equal(isFailureKind('max-tokens', undefined), false)
  assert.equal(isFailureKind('forked', undefined), false)
  assert.equal(isFailureKind('completed', undefined), false)
})

test('失败摘要取 message，缺省回退 kind', () => {
  assert.equal(failureOf(undefined), undefined)
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'rate limited', at: 1 } }), 'rate limited')
  assert.equal(failureOf({ lastTurnEnd: { kind: 'blocked', at: 1 } }), 'blocked')
  assert.equal(failureOf({ lastTurnEnd: { kind: 'completed', at: 1 } }), undefined)
  assert.equal(failureOf({ lastTurnEnd: { kind: 'aborted', cause: 'user', at: 1 } }), undefined)
})

test('自动续跑不清红，用户重新进入任务才清红（B-001）', () => {
  // 真机 117 个「失败→重启」样本：4 个无 user/message 的自动续跑间隔 231–420ms，
  // 全部以 aborted/user 收场；113 个用户发起的重启中位 49.5s。阈值取 1s 落在两带之间。
  const errorAt = 100

  // 自动续跑（<1s）：红必须保住，否则红寿命不足一秒、球上永远看不到失败
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt + 231 }), 'boom', '231ms 是自动续跑')
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt + 420 }), 'boom', '420ms 是自动续跑')
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt + 999 }), 'boom', '阈值下方仍算续跑')

  // 用户重新进入任务（≥1s）：D-004 的第三个出口，必须清红转蓝
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt + 1000 }), undefined, '阈值处即恢复')
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt + 49547 }), undefined, '中位用户间隔')

  // 失败尾里同样生效：比较基准是「最后一条失败的 at」，不是整条尾的最新时间。
  // aborted(user) 不算失败，所以它不刷新基准，200ms 后重启仍在续跑带内 → 仍红。
  assert.equal(failureOf({
    endsSinceCompletion: [
      { kind: 'error', message: 'UNKNOWN_MODEL', at: 100 },
      { kind: 'aborted', cause: 'user', at: 200 },
    ],
    turnStartAt: 300,
  }), 'UNKNOWN_MODEL', 'aborted(user) 不刷新失败基准，200ms 后重启仍算续跑')

  // 同一个尾部，但重启发生在基准之后 1s 以上 → 用户重新进入任务，清红
  assert.equal(failureOf({
    endsSinceCompletion: [
      { kind: 'error', message: 'UNKNOWN_MODEL', at: 100 },
      { kind: 'aborted', cause: 'user', at: 200 },
    ],
    turnStartAt: 5000,
  }), undefined, '远超续跑带的重启即恢复')

  // 没有 turn/start 记录（Host 未收到）时保持原有语义：失败就是失败
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }), 'boom')
  // turn/start 早于失败（上一轮的开始时刻）不得被当成恢复
  assert.equal(failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt }, turnStartAt: errorAt - 50 }), 'boom')
})

test('实时 running 是「已重新进入」的第二证据（红不再等一个轮询周期）', () => {
  // 真机实测（2026-10-30）：用户重进一个红色会话后，球最多继续显示红 4999ms（中位 ~2.5s），
  // 因为「是否已重新进入」当时只接受 Host 的 turnStartAt，而它要走 5s 轮询。
  // 实时 running 是同一事实的 0 延迟证据，但**必须共用同一个 1s 时间带**，否则
  // 宿主自动重试（231–420ms）会把红刷掉 —— 那正是 D-025 当年要防的事。
  const errorAt = 1_060_000

  // 自动重试带内：实时在跑也不清红
  assert.equal(
    failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }, { running: true, now: errorAt + 231 }),
    'boom',
    '231ms 是宿主自动续跑，实时在跑也不能清红',
  )
  assert.equal(
    failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }, { running: true, now: errorAt + 999 }),
    'boom',
    '阈值下方仍算续跑',
  )

  // 阈值以上：用户重进立刻生效，不用等轮询
  assert.equal(
    failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }, { running: true, now: errorAt + 1000 }),
    undefined,
    '阈值处实时在跑即视为用户重进',
  )
  assert.equal(
    failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }, { running: true, now: errorAt + 60_000 }),
    undefined,
    '用户重进：实时在跑 + 远超续跑带',
  )

  // 实时没在跑时，live 不提供任何证据（不能凭空恢复）
  assert.equal(
    failureOf({ lastTurnEnd: { kind: 'error', message: 'boom', at: errorAt } }, { running: false, now: errorAt + 60_000 }),
    'boom',
    '只有 running === true 才算证据',
  )

  // 失败尾分支同样生效
  assert.equal(
    failureOf({
      endsSinceCompletion: [{ kind: 'error', message: 'UNKNOWN_MODEL', at: errorAt }],
    }, { running: true, now: errorAt + 60_000 }),
    undefined,
    '失败尾分支也必须接受实时证据',
  )

  // deriveView 端到端：红会话重新进入后当帧转蓝，与球上的可见行为一致
  const session1 = session('s1')
  const record = { turnStartAt: errorAt - 300_000, endsSinceCompletion: [{ kind: 'error', message: 'boom', at: errorAt }] }
  const state = hostState({ s1: record })
  const runningNow = new Map([['s1', status({ running: true })]])
  const view = deriveView([session1], runningNow, [], state, errorAt + 60_000, undefined, EMPTY_WITNESSES, WINDOW)
  assert.equal(view.entries[0]?.color, 'blue', '用户重进后球必须立刻显示蓝，而不是继续占红色扇区')
})

test('失败尾：只有 completed 才算这次失败尝试结束', () => {
  assert.equal(failureOf({ endsSinceCompletion: [{ kind: 'error', message: 'boom', at: 100 }] }), 'boom')
  // error → aborted(user)：两次都算失败尝试内的记录，error 仍在
  assert.equal(failureOf({
    endsSinceCompletion: [
      { kind: 'error', message: 'UNKNOWN_MODEL', at: 100 },
      { kind: 'aborted', cause: 'user', at: 200 },
    ],
  }), 'UNKNOWN_MODEL', '中止不得抹掉前面的失败')
  // completed 后 Host 清空失败尾，红自然消失
  assert.equal(failureOf({ endsSinceCompletion: [], lastTurnEnd: { kind: 'completed', at: 300 } }), undefined)
  // 只有用户中止、没有真失败时不得判红
  assert.equal(failureOf({ endsSinceCompletion: [{ kind: 'aborted', cause: 'user', at: 200 }] }), undefined)
})

test('绿色是持久事实：刷新后 completionUnread 清空不得变灰', () => {
  const now = 1_000_000
  // 宿主只给 boolean，且它在页面重载后重建为空；完成时刻才是可靠依据。
  const sessions = [session('s1')]
  const host = hostState({ s1: { lastTurnEnd: { kind: 'completed', at: now - 60_000 } } })
  const unread = deriveView(sessions, new Map([['s1', status({ completionUnread: true })]]), [], host, now)
  const reloaded = deriveView(sessions, new Map([['s1', status({ completionUnread: false })]]), [], host, now)
  assert.equal(unread.entries[0].color, 'green')
  assert.equal(reloaded.entries[0].color, 'green', '重载后仍应是绿色')
  assert.equal(taskEntries(reloaded.entries).length, 1, '绿色必须仍进面板')
})

test('绿色仍受阈值约束，且重新进入任务状态会转蓝', () => {
  const now = 1_000_000
  const sessions = [session('s1')]
  const host = hostState({ s1: { lastTurnEnd: { kind: 'completed', at: now - 90_000 } } }, 60_000)
  assert.equal(deriveView(sessions, new Map(), [], host, now).entries.length, 0, '超阈值必须移除')
  const running = hostState({ s1: { lastTurnEnd: { kind: 'completed', at: now - 1_000 } } }, 60_000)
  assert.equal(
    deriveView(sessions, new Map([['s1', status({ running: true })]]), [], running, now).entries[0].color,
    'blue',
    '重新进入任务状态转蓝，绿的出口之一',
  )
})

test('失败优先于持久绿色', () => {
  const now = 1_000_000
  const host = hostState({
    s1: {
      lastTurnEnd: { kind: 'error', message: 'boom', at: now - 1_000 },
      endsSinceCompletion: [{ kind: 'error', message: 'boom', at: now - 1_000 }],
    },
  })
  const view = deriveView([session('s1')], new Map([['s1', status()]]), [], host, now)
  assert.equal(view.entries[0].color, 'red')
})

test('完成时刻只来自 completed 的 turn/end', () => {
  assert.equal(completedAtOf(undefined), undefined)
  assert.equal(completedAtOf({ lastTurnEnd: { kind: 'completed', at: 42 } }), 42)
  assert.equal(completedAtOf({ lastTurnEnd: { kind: 'error', message: 'x', at: 42 } }), undefined)
})

test('绿色过期：只有绿色会过期，红黄蓝永不过期（D-004）', () => {
  const retention = 30 * 60_000
  assert.equal(isGreenExpired('green', 0, retention, 29 * 60_000), false)
  assert.equal(isGreenExpired('green', 0, retention, 31 * 60_000), true)
  assert.equal(isGreenExpired('green', undefined, retention, 31 * 60_000), false, '完成时刻未知就不判过期')
  for (const color of ['red', 'yellow', 'blue', 'gray']) {
    assert.equal(isGreenExpired(color, 0, retention, 999 * 60_000), false)
  }
  assert.equal(isExpired(undefined, retention, 1000), false)
})

test('折叠：颜色未变仍折叠，颜色一变自动取消（D-006）', () => {
  assert.equal(isFoldedNow(undefined, 'red'), false)
  assert.equal(isFoldedNow({ foldedAt: 10, foldedColor: 'red' }, 'red'), true)
  assert.equal(isFoldedNow({ foldedAt: 10, foldedColor: 'red' }, 'blue'), false, '状态一变就取消勾选')
  assert.equal(isFoldedNow({ foldedAt: 10 }, 'red'), false, '没有颜色记录说明折叠已失效')
})

test('foldedIds 只收集颜色仍然匹配的会话', () => {
  const state = hostState({
    a: { foldedAt: 1, foldedColor: 'red' },
    b: { foldedAt: 2, foldedColor: 'green' },
    c: { foldedAt: 3, foldedColor: 'red' },
  })
  const colors = new Map([['a', 'red'], ['b', 'blue'], ['c', 'red']])
  assert.deepEqual([...foldedIds(state, colors)].sort(), ['a', 'c'])
})

test('子代理与空白会话不参与扇形与面板', () => {
  const sessions = [session('a'), session('b', { origin: 'subagent' }), session('c', { blank: true })]
  assert.deepEqual(visibleSessions(sessions).map((item) => item.id), ['a'])
})

test('工作区分组：按 workspace 归组，剩余落入未分组', () => {
  const sessions = [session('a'), session('b'), session('c')]
  const groups = groupByWorkspace(sessions, [
    { workspaceId: 'w1', path: '/w1', title: 'W1', sessionIds: ['a', 'b'] },
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.key, 'w1')
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id), ['a', 'b'])
  assert.equal(groups[1]?.key, 'ungrouped')
})

test('扇区角度：按会话数等分，灰色不占扇区', () => {
  const entries = [
    { id: 'a', title: 'a', color: 'red', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
    { id: 'b', title: 'b', color: 'blue', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
    { id: 'c', title: 'c', color: 'gray', workspaceId: undefined, updatedAt: 0, completedAt: undefined },
  ]
  const sectors = sectorAngles(entries)
  assert.equal(sectors.length, 2)
  assert.equal(sectors[0]?.start, 0)
  assert.equal(sectors[0]?.end, 180)
  assert.equal(sectors[1]?.end, 360)
  assert.deepEqual(sectorAngles([]), [])
})

test('颜色计数', () => {
  const entry = (id, color) => ({ id, title: id, color, workspaceId: undefined, updatedAt: 0, completedAt: undefined })
  const counts = countByColor([entry('a', 'red'), entry('b', 'red'), entry('c', 'green')])
  assert.equal(counts.red, 2)
  assert.equal(counts.green, 1)
  assert.equal(counts.blue, 0)
})

test('勾选对扇形的影响：四色统一，勾选即不占扇形（D-028 推翻 D-024 的蓝豁免）', () => {
  const folded = new Set(['a', 'b', 'c', 'g'])
  // D-028：球与面板必须口径一致，所以勾选「已处理」对每一色都意味着不占扇形。
  // 蓝色此前被 D-024 豁免，导致面板说「已处理」而球仍在显示 —— 用户明确否决。
  assert.equal(occupiesSector('red', folded, 'a'), false)
  assert.equal(occupiesSector('yellow', folded, 'b'), false)
  assert.equal(occupiesSector('blue', folded, 'c'), false)
  assert.equal(occupiesSector('green', folded, 'g'), false)
  // 未勾选时四色都占扇形
  assert.equal(occupiesSector('red', new Set(), 'a'), true)
  assert.equal(occupiesSector('yellow', new Set(), 'b'), true)
  assert.equal(occupiesSector('blue', new Set(), 'c'), true)
  assert.equal(occupiesSector('green', new Set(), 'g'), true)
  // 灰色永远不占
  assert.equal(occupiesSector('gray', new Set(), 'x'), false)
  assert.equal(occupiesSector('gray', folded, 'x'), false)
})

test('deriveView：合并宿主记录、状态、工作区与过期', () => {
  const now = 100 * 60_000
  const sessions = [
    session('run'),
    session('fail'),
    session('fresh'),
    session('old'),
    session('idle'),
    session('sub', { origin: 'subagent' }),
  ]
  const statuses = new Map([
    ['run', status({ running: true })],
    ['fail', status({ completionUnread: true })],
    ['fresh', status({ completionUnread: true })],
    ['old', status({ completionUnread: true })],
  ])
  const state = hostState({
    fail: { lastTurnEnd: { kind: 'error', message: 'boom', at: now - 60_000 } },
    fresh: { lastTurnEnd: { kind: 'completed', at: now - 60_000 } },
    old: { lastTurnEnd: { kind: 'completed', at: now - 31 * 60_000 } },
    old2: { lastTurnEnd: { kind: 'completed', at: 0 } },
  })
  const view = deriveView(sessions, statuses, [], state, now)
  const byId = new Map(view.entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('run')?.color, 'blue')
  assert.equal(byId.get('fail')?.color, 'red', '失败与完成未读同时成立时红优先')
  assert.equal(byId.get('fresh')?.color, 'green')
  assert.equal(byId.get('fresh')?.completedAt, now - 60_000)
  assert.equal(byId.has('old'), false, '绿色超期后从派生结果中移除')
  assert.equal(byId.get('idle')?.color, 'gray')
  assert.equal(byId.has('sub'), false)
  assert.equal(view.failures.get('fail'), 'boom')
})

test('deriveView：折叠颜色由当前颜色决定，状态变化自动解除', () => {
  const now = 1000
  const sessions = [session('a'), session('b')]
  const statuses = new Map([['a', status({ running: true })]])
  const state = hostState({
    a: { foldedAt: 1, foldedColor: 'blue' },
    b: { foldedAt: 1, foldedColor: 'red' },
  })
  const view = deriveView(sessions, statuses, [], state, now)
  assert.deepEqual([...view.folded], ['a'])
})

test('taskEntries 过滤灰色（面板只列有状态的会话）', () => {
  const entry = (id, color) => ({ id, title: id, color, workspaceId: undefined, updatedAt: 0, completedAt: undefined })
  assert.deepEqual(taskEntries([entry('a', 'gray'), entry('b', 'red')]).map((item) => item.id), ['b'])
})

// 用户实测 bug（2026-10-27）：蓝→绿→勾选→再执行→完成，会话直接掉进「已处理」，
// 蓝色扇形消失且没变回绿色。根因是折叠只按颜色比对：绕一圈回到绿色时颜色又相等，
// 折叠被"复活"。判据必须是「折叠之后有没有新的 turn 活动」。
test('折叠不得因绕回同色而复活（蓝→绿→勾选→蓝→绿）', () => {
  const foldedAt = 1000
  const folded = { foldedAt, foldedColor: 'green' }

  // 折叠当下就是绿：仍是折叠态
  assert.equal(isFoldedNow(folded, 'green'), true)

  // 折叠后又跑了一轮（turn/start 晚于折叠）→ 即使颜色回到绿，折叠也必须已解除
  assert.equal(isFoldedNow({ ...folded, turnStartAt: 2000 }, 'green'), false, '重新执行后不得复活')
  assert.equal(isFoldedNow({ ...folded, turnStartAt: 2000, lastTurnEnd: { kind: 'completed', at: 3000 } }, 'green'), false, '完成时刻晚于折叠也不得复活')

  // 只有 turn/end 晚于折叠（没记录到 start）同样要解除
  assert.equal(isFoldedNow({ ...folded, lastTurnEnd: { kind: 'completed', at: 3000 } }, 'green'), false)

  // 活动早于折叠：不解除（折叠那一刻之后的才算变化）
  assert.equal(isFoldedNow({ ...folded, turnStartAt: 500, lastTurnEnd: { kind: 'completed', at: 900 } }, 'green'), true)

  // 颜色不同：无论活动如何都不算折叠（原有语义不变）
  assert.equal(isFoldedNow({ ...folded, turnStartAt: 2000 }, 'blue'), false)
})

// 用户实测（2026-10-27/28）：球有时整个消失，刷新又回来。根因是渲染抛错被 slot 的
// 错误边界吞掉、卸载整个 overlay。除了修具体字段，这条兜底把「单行形状异常」的
// 杀伤范围限制在那一行，不再波及整个球。
test('宿主行形状异常不得让 deriveView 抛错（否则整个 overlay 被卸载）', () => {
  const good = session('a')
  // 工作区缺 sessionIds
  const brokenWorkspace = [{ workspaceId: 'w1', path: '/w1', title: '项目一' }]
  assert.doesNotThrow(() => deriveView([good], new Map(), brokenWorkspace, hostState({}), 1000))

  // 会话行缺 id / title / displayTitle
  const brokenSession = { id: undefined, title: undefined, displayTitle: undefined, blank: false, updatedAt: 1 }
  assert.doesNotThrow(() => deriveView([brokenSession], new Map(), [], hostState({}), 1000))
  const view = deriveView([brokenSession], new Map(), [], hostState({}), 1000)
  assert.equal(view.entries.length, 0, '无 id 的行应被过滤而不是抛错')

  // groupByWorkspace 同样不得抛
  assert.doesNotThrow(() => groupByWorkspace([good], brokenWorkspace))
})

test('titleOf：缺 title 时回退到 displayTitle，再回退到 id', () => {
  assert.equal(titleOf({ title: '  标题  ', displayTitle: 'x', id: 'i' }), '标题')
  assert.equal(titleOf({ title: '   ', displayTitle: ' 显示名 ', id: 'i' }), '显示名')
  assert.equal(titleOf({ title: undefined, displayTitle: undefined, id: 'sess-1' }), 'sess-1')
  assert.equal(titleOf({}), '')
})

// D-005（用户 2026-10-28 修正）：归档 = 会话完全退场。
// 面板的「未处理」区必须与扇形保持同一口径 —— 归档后两者都不再出现它。
// 收敛到 deriveView 一个 owner，两处不可能再各说各话。
test('D-005：归档会话在扇形与面板中一起退场', () => {
  const entry = (id, color) => ({ id, title: id, color, workspaceId: undefined, updatedAt: 0, completedAt: undefined })
  // 归档行的过滤收敛在 deriveView，所以 occupiesSector 不再需要归档参数；
  // 这里验证它保持 D-028 的语义（四色统一，勾选即不占）。
  assert.equal(occupiesSector('blue', new Set(), 'b'), true, '未折叠的蓝占扇形')
  assert.equal(occupiesSector('blue', new Set(['b']), 'b'), false, '折叠的蓝不占扇形（D-028）')
  assert.equal(occupiesSector('red', new Set(), 'x'), true, '未归档的红仍占扇形')
  assert.equal(occupiesSector('red', new Set(['x']), 'x'), false, '折叠的红不占扇形')
  assert.deepEqual(
    sectorEntries([entry('r', 'red'), entry('b', 'blue')], new Set()).map((e) => e.id),
    ['r', 'b'],
    '未归档的会话都进扇形',
  )

  // 记录层面：归档行根本不出现在 entries 里 —— 面板与扇形因此天然一致
  const view = deriveView(
    [
      { id: 'archived-red', title: 'red', displayTitle: 'red', blank: false, updatedAt: 1 },
      { id: 'live-red', title: 'red2', displayTitle: 'red2', blank: false, updatedAt: 2 },
    ],
    new Map(),
    [],
    hostState({
      'archived-red': { lastTurnEnd: { kind: 'error', message: 'boom', at: 5 }, endsSinceCompletion: [{ kind: 'error', message: 'boom', at: 5 }] },
      'live-red': { lastTurnEnd: { kind: 'error', message: 'boom2', at: 6 }, endsSinceCompletion: [{ kind: 'error', message: 'boom2', at: 6 }] },
    }),
    1000,
    { archivedSessionIds: new Set(['archived-red']) },
  )
  assert.deepEqual(view.entries.map((e) => e.id), ['live-red'], '归档行不进 entries')
  assert.equal(view.failures.has('archived-red'), false, '归档行也不进 failures')
  // 面板与扇形读到的是同一份 entries，所以两者必然一致（这正是收敛到一个 owner 的意义）
  assert.deepEqual(taskEntries(view.entries).map((e) => e.id), ['live-red'])
  assert.deepEqual(sectorEntries(view.entries, view.folded).map((e) => e.id), ['live-red'])
})

// D-034：勾选的语义状态必须立刻生效，动画与 Host 轮询都不参与「算不算已处理」。
// 旧实现把系统正确性压在 220ms 动画 + 5s 轮询上（BUG1 的根因）。

test('D-034：本地折叠覆盖立即生效，球与面板看到同一个最终态', () => {
  const host = new Set()
  const overrides = new Map([['s1', { folded: true, color: 'blue', at: 1000 }]])
  const effective = overriddenFolds(host, overrides)
  assert.equal(effective.has('s1'), true, 'Host 还没确认，也必须立刻算「已处理」')
  assert.equal(host.has('s1'), false, '覆盖不能改写 Host 集合本身')
  // 撤销同理：Host 仍说已处理，但本地已经放开
  const unfolding = new Map([['s1', { folded: false, color: 'blue', at: 2000 }]])
  assert.equal(overriddenFolds(new Set(['s1']), unfolding).has('s1'), false)
  // 空覆盖时返回同一个对象，避免每帧新建集合
  assert.equal(overriddenFolds(host, new Map()), host)
})

test('D-034：Host 确认后立即交还所有权', () => {
  const overrides = new Map([['s1', { folded: true, color: 'blue', at: 1000 }]])
  const colors = new Map([['s1', 'blue']])
  assert.equal(
    pruneFoldOverrides(overrides, new Set(['s1']), colors, 1001).size,
    0,
    'Host 已同意折叠，覆盖不再携带信息',
  )
  // Host 还没动（写入在途），不能提前清掉 —— 否则行会闪回
  assert.equal(
    pruneFoldOverrides(overrides, new Set(), colors, 1001),
    overrides,
    'Host 尚未确认时必须保留覆盖',
  )
})

test('D-034：状态变化 / 条目消失 / 超时都会撤销覆盖（写失败可自愈）', () => {
  const overrides = new Map([['s1', { folded: true, color: 'blue', at: 1000 }]])
  // D-006：颜色变了，折叠自动失效
  assert.equal(
    pruneFoldOverrides(overrides, new Set(), new Map([['s1', 'green']]), 1001).size,
    0,
    '颜色变化必须撤销覆盖',
  )
  // 条目被归档/过期后不再有任何意义
  assert.equal(
    pruneFoldOverrides(overrides, new Set(), new Map(), 1001).size,
    0,
    '条目离开推导后必须撤销覆盖',
  )
  // 写失败：覆盖最多活过两个轮询周期，然后行回来
  const colors = new Map([['s1', 'blue']])
  assert.equal(
    pruneFoldOverrides(overrides, new Set(), colors, 1000 + FOLD_RECONCILE_MS).size,
    1,
    '窗口内必须保留',
  )
  assert.equal(
    pruneFoldOverrides(overrides, new Set(), colors, 1001 + FOLD_RECONCILE_MS).size,
    0,
    '超过窗口必须撤销，不能永久隐藏',
  )
  assert.ok(FOLD_RECONCILE_MS >= 10_000, '安全窗口必须宽于两个 5s 轮询周期')
})

// ── B-009（用户 2026-10-30 报障）─────────────────────────────────────────────
// 聚焦（= 主视图）中的蓝色会话完成任务时，球先变灰一两秒再变绿，且绿色气泡永远不弹。
//
// 根因不在气泡、也不在设置：`deriveView` 拼颜色时用了两个延迟完全不同的数据源 ——
// ① `SessionStatus` 是事件驱动，turn 结束当帧 `running` 就变 false；
// ② Host 的 `turn/end` 记录要等下一个 5s 轮询才到。
// 中间窗口里「实时说不在跑」+「Host 还没有完成时刻」被判成灰。而 `completionUnread`
// 专为主视图**不**置位（宿主库设计：主视图等于用户正在看），所以聚焦会话连实时绿都拿不到。
//
// 更严重的是灰闪把边**劈成两段**：blue→gray、gray→green，而 `transitionsOf` 只播
// 「离开 blue」的边 —— 于是气泡条件永远不成立，与「完成时提醒」开不开无关。

/** Ordered [from, to] pairs for entries whose colour actually changed. */
function transitionPairs(before, after) {
  const pairs = []
  for (const [id, to] of after) {
    const from = before.get(id)
    if (from === undefined || from === to) continue
    pairs.push([from, to])
  }
  return pairs
}

const colorsOf = (view) => new Map(view.entries.map((entry) => [entry.id, entry.color]))

// 观察窗：两个轮询周期，与实现一致
const WINDOW = flightWindowMs(DEFAULT_POLL_MS)
const witnessed = (ids, at) => new Map(ids.map((id) => [id, at]))

test('B-009：turnInFlight 需要「Host 无结束记录」+「客户端刚看见它在跑」两个见证', () => {
  const now = 1_000_000
  // 单个判据各自都不够
  assert.equal(turnInFlight(undefined, now, now, WINDOW), false)
  assert.equal(turnInFlight({}, now, now, WINDOW), false, '没有 turnStartAt 的旧记录不能当成在跑')
  assert.equal(
    turnInFlight({ turnStartAt: now - 1000 }, undefined, now, WINDOW),
    false,
    '只有 Host 记录、没有客户端见证 → 不得判在跑（这正是 false-blue 成因）',
  )
  assert.equal(
    turnInFlight({ turnStartAt: now - 1000 }, now - WINDOW - 1, now, WINDOW),
    false,
    '见证已过期 → 不得判在跑',
  )
  // 两个都成立
  assert.equal(turnInFlight({ turnStartAt: now - 1000 }, now - 500, now, WINDOW), true, '刚看见在跑 + 无结束记录')
  // Host 已记录结束，即使刚见它在跑也不算
  assert.equal(
    turnInFlight({ turnStartAt: now - 1000, lastTurnEnd: { kind: 'completed', at: now - 900 } }, now - 500, now, WINDOW),
    false,
    'Host 记录了结束（晚于开始）→ 不算在跑',
  )
  assert.equal(
    turnInFlight({ turnStartAt: now - 100, lastTurnEnd: { kind: 'completed', at: now - 900 } }, now - 50, now, WINDOW),
    true,
    '新 turn 已开始，旧结束不算数',
  )
})

test('B-009：陈旧未结束记录不得被当成在跑（false-blue 回归）', () => {
  const DAYS = 86_400_000
  const now = 1_000_000 + 6 * DAYS
  const sessions = [session('stale'), session('live')]
  // 真机样本形状：turnStartAt 晚于 lastTurnEnd.at，但两者都是几天前
  const state = hostState({
    stale: { turnStartAt: now - DAYS * 1.9, lastTurnEnd: { kind: 'completed', at: now - DAYS * 1.9 - 6_000 } },
    live: { turnStartAt: now - 3_000 },
  })
  // 客户端从没见 stale 在跑；只见过 live 在跑
  const witnesses = witnessed(['live'], now - 2_000)
  const idle = new Map([
    ['stale', status({ running: false, completionUnread: false })],
    ['live', status({ running: false, completionUnread: false })],
  ])
  const view = deriveView(sessions, idle, [], state, now, undefined, witnesses, WINDOW)
  const byId = colorsOf(view)
  // stale 有旧 completed → 绿（若过保留期则消失），绝不能是蓝
  assert.notEqual(byId.get('stale'), 'blue', '几天前的陈旧未结束记录不得显示为执行中')
  // live：刚见它在跑，Host 尚无结束 → 蓝（这正是要保留的行为）
  assert.equal(byId.get('live'), 'blue', '真在跑的会话仍要显示蓝')
})

test('B-009：noteRunning 只在有新观察时更新，pruneWitnesses 会过期清理', () => {
  const now = 1_000_000
  // 首次观察写入
  const first = noteRunning(EMPTY_WITNESSES, ['a', 'b'], now)
  assert.equal(first.get('a'), now)
  assert.equal(first.get('b'), now)
  // 同一时刻重复观察不改对象（保持引用稳定，避免每轮重渲染）
  assert.equal(noteRunning(first, ['a'], now), first)
  // 一秒后刷新时间戳
  const later = noteRunning(first, ['a'], now + 1_500)
  assert.equal(later.get('a'), now + 1_500)
  assert.notEqual(later, first)
  // 修剪过期项
  const pruned = pruneWitnesses(later, now + WINDOW + 2_000, WINDOW)
  assert.equal(pruned.has('a'), false)
  assert.equal(pruned.has('b'), false, 'b 也早已过期')
  // 仍在窗口内的不动
  assert.equal(pruneWitnesses(later, now + 500, WINDOW), later)
})

test('B-009：聚焦会话完成时不闪灰，blue→green 是一条边', () => {
  const now = 1_000_000
  const sessions = [session('s1')]
  const state = hostState({ s1: { turnStartAt: now - 5_000 } })
  // 客户端刚才看见它在跑 —— 这是灰闪窗口里唯一能说明「它还在跑」的见证
  const witnesses = witnessed(['s1'], now - 100)

  // 阶段 1：正在跑
  const running = new Map([['s1', status({ running: true })]])
  const viewRunning = deriveView(sessions, running, [], state, now, undefined, witnesses, WINDOW)
  assert.equal(viewRunning.entries[0]?.color, 'blue')

  // 阶段 2：turn 刚结束，事件已把 running 置 false，但 Host 的 turn/end 还没被轮询取回。
  // 聚焦会话的 completionUnread 恒为 false —— 这就是灰闪窗口。
  const stopped = new Map([['s1', status({ running: false, completionUnread: false })]])
  const viewStopped = deriveView(sessions, stopped, [], state, now + 500, undefined, witnesses, WINDOW)
  assert.equal(viewStopped.entries[0]?.color, 'blue', 'Host 尚未记录结束，不得判灰')

  // 阶段 3：轮询落地，Host 带回 completed
  const doneState = hostState({
    s1: { turnStartAt: now - 5_000, lastTurnEnd: { kind: 'completed', at: now + 600 } },
  })
  const viewDone = deriveView(sessions, stopped, [], doneState, now + 900, undefined, witnesses, WINDOW)
  assert.equal(viewDone.entries[0]?.color, 'green')

  // 关键断言：整条链路上只允许出现一条 blue→green，中途不得插入灰色。
  const edges = [
    ...transitionPairs(colorsOf(viewRunning), colorsOf(viewStopped)),
    ...transitionPairs(colorsOf(viewStopped), colorsOf(viewDone)),
  ]
  assert.deepEqual(edges, [['blue', 'green']], '不得出现 blue→gray，否则气泡的 from===blue 条件永远不成立')
})

test('B-009：新 turn 开始后不得继续显示旧绿色（D-004 出口）', () => {
  const now = 1_000_000
  const sessions = [session('s1')]
  const state = hostState({
    s1: { turnStartAt: now - 1_000, lastTurnEnd: { kind: 'completed', at: now - 60_000 } },
  })
  const idle = new Map([['s1', status({ running: false, completionUnread: false })]])
  const view = deriveView(sessions, idle, [], state, now, undefined, witnessed(['s1'], now - 500), WINDOW)
  assert.equal(view.entries[0]?.color, 'blue', '重新执行时旧完成不得继续冒充绿色')
})

test('B-009：Host 已记录非完成结束且无新 turn 时，仍正常回到灰', () => {
  const now = 1_000_000
  const sessions = [session('s1')]
  // 用户主动停止：aborted/user 不判红，Host 有结束记录、无完成时刻 → 应为灰
  const state = hostState({
    s1: { turnStartAt: now - 5_000, lastTurnEnd: { kind: 'aborted', cause: 'user', at: now - 100 } },
  })
  const idle = new Map([['s1', status({ running: false, completionUnread: false })]])
  const view = deriveView(sessions, idle, [], state, now, undefined, witnessed(['s1'], now - 50), WINDOW)
  assert.equal(view.entries[0]?.color, 'gray', '真结束的非完成轮必须回到灰，不能被判成在跑')
})

/**
 * Replay the overlay's render sequence with a chosen clock discipline.
 *
 * The witness window is judged as `now - stamp <= windowMs` where BOTH numbers
 * come from the SAME clock. So the clock's step size decides what that
 * comparison actually means:
 *
 * - step >= window  → it degenerates into "was the stamp taken in the current
 *   step", and every step boundary silently drops witnesses that are still
 *   valid;
 * - step < window   → it measures elapsed time, which is the intent.
 *
 * `useNow()` used to return the timestamp of the last 15 s tick, so the overlay
 * stamped and judged with a clock that advanced in 15 s steps against a 10 s
 * window. Measured 2026-10-30 on the real build: ~19% of turn endings painted
 * blue→GRAY→green for 0.1–5.1 s, which also split the edge and kept the
 * completion bubble from firing — the very symptom D-048 had already "fixed",
 * before the witness existed.
 */
function simulateOverlay({ clockStepMs, turnEndAt, hostRecordLagMs = 3_000, pollMs = DEFAULT_POLL_MS, renderCapMs = 40_000 }) {
  const events = []
  for (let t = 0; t <= turnEndAt + renderCapMs; t += clockStepMs) events.push({ t, kind: 'clock' })
  for (let t = 0; t <= turnEndAt + renderCapMs; t += pollMs) {
    // The Host's flushed record is readable on the first poll issued after the write.
    events.push({ t: t + 100, kind: 'poll', issuedAt: t })
  }
  events.push({ t: turnEndAt, kind: 'status' })
  events.sort((left, right) => left.t - right.t || (left.kind === 'clock' ? -1 : 1))

  const sessions = [session('s1')]
  let witnesses = EMPTY_WITNESSES
  let clockNow = 0
  let previousRecordHasEnd = false
  const seq = []
  let lastColor
  for (const event of events) {
    if (event.kind === 'clock') clockNow = event.t
    const running = event.t < turnEndAt
    // One clock for both the stamp and the judgement — that is the invariant.
    witnesses = noteRunning(witnesses, running ? ['s1'] : [], clockNow)
    witnesses = pruneWitnesses(witnesses, clockNow, WINDOW)
    const recordHasEnd = event.kind === 'poll'
      ? event.issuedAt >= turnEndAt + hostRecordLagMs
      : previousRecordHasEnd
    previousRecordHasEnd = recordHasEnd
    const state = hostState({
      s1: recordHasEnd
        ? { turnStartAt: 0, lastTurnEnd: { kind: 'completed', at: turnEndAt } }
        : { turnStartAt: 0 },
    })
    const statuses = new Map([['s1', status({ running, completionUnread: false })]])
    const view = deriveView(sessions, statuses, [], state, clockNow, undefined, witnesses, WINDOW)
    const color = view.entries[0]?.color ?? 'gray'
    if (color !== lastColor) seq.push(color)
    lastColor = color
  }
  return seq.join('>')
}

test('B-009：见证时钟必须比窗口细，否则每次 tick 都会误丢见证（灰闪回归）', () => {
  // 判据的前提：一整个时钟步长里都可能发生「turn 已结束、Host 记录还没轮询到」。
  // 取一个正好落在该空档里的结束时刻，扫遍相位。
  const coarse = []
  for (let endAt = 20_000; endAt < 35_000; endAt += 250) {
    coarse.push(simulateOverlay({ clockStepMs: 15_000, turnEndAt: endAt }))
  }
  assert.ok(
    coarse.some((seq) => seq.includes('gray')),
    '前提失效：粗时钟下这段时序应当复现 blue→gray→green，否则本用例没有再锁住任何东西',
  )
  assert.ok(
    coarse.every((seq) => !seq.startsWith('gray')),
    '灰闪只能出现在完成之后，不能从头就是灰',
  )

  // 修法本身：时钟细于窗口之后，任何相位都只有一条 blue→green。
  for (const step of [5_000, 2_000, 1_000]) {
    for (let endAt = 20_000; endAt < 35_000; endAt += 250) {
      const seq = simulateOverlay({ clockStepMs: step, turnEndAt: endAt })
      assert.equal(
        seq,
        'blue>green',
        `时钟步长 ${step}ms < 窗口 ${WINDOW}ms 时不得出现任何中间色（endAt=${endAt}）`,
      )
    }
  }

  assert.ok(WINDOW < 15_000, `窗口 ${WINDOW}ms 必须小于曾经的 tick 粒度 15s，否则本用例的前提不成立`)
})

/**
 * 上面那条用例证明了「时钟粗于窗口就会灰闪」，但它自己模拟时钟，**锁不住实现**：
 * 把 `useNow` 改回旧写法，它照样绿（实测确认过）。真正的护栏必须读取实际源码。
 */
test('B-009：useNow 必须返回真实时间，不能返回上一次 tick 的时间戳（源码门禁的测试侧副本）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = await readFile(join(root, 'src/client/host-state.ts'), 'utf8')
  const body = source.slice(source.indexOf('export function useNow'))
  assert.ok(
    /return Date\.now\(\)/.test(body),
    'useNow 必须返回 Date.now()；返回 tick 捕获值会让 10s 见证窗口按 15s 步长退化',
  )
  assert.equal(
    /setNow\(Date\.now\(\)\)/.test(body),
    false,
    'useNow 不得把 tick 时间戳存进 state 再返回 —— 那正是把粗时钟当作判据时钟的写法',
  )
})
