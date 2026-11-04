import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyFold,
  applyTurnEnd,
  applyTurnStart,
  emptyDocument,
  parseDocument,
  pruneDocument,
  serializeDocument,
} from '../lib/index.js'
import { completedAtOf, isGreenExpired } from '../lib/model.mjs'

const MINUTE = 60_000

test('重复 completed 必须刷新完成时刻（B-008）', () => {
  const document = emptyDocument()
  assert.equal(applyTurnEnd(document, 's1', { kind: 'completed', at: 1000 }), true)
  // 每次完成都是一条新事实：绿色计时与折叠失效都从这一刻算起。
  assert.equal(applyTurnEnd(document, 's1', { kind: 'completed', at: 5000 }), true)
  assert.equal(document.sessions.s1.lastTurnEnd.at, 5000, '重复的 completed 不得沿用首次完成时刻')
  // 同一条 completed 重复投递（同一 at）仍不得无条件重写。
  assert.equal(applyTurnEnd(document, 's1', { kind: 'completed', at: 5000 }), false)
})

test('重复 completed 后绿色仍在保留窗内（B-008 端到端推导）', () => {
  const document = emptyDocument()
  const first = 1_000_000
  applyTurnEnd(document, 's1', { kind: 'completed', at: first })
  // 实测会话 964edce1：7 次 completed，时刻被冻结在首次，导致绿色永久过期。
  applyTurnEnd(document, 's1', { kind: 'completed', at: first + 20 * MINUTE })
  const completedAt = completedAtOf(document.sessions.s1)
  assert.equal(completedAt, first + 20 * MINUTE)
  assert.equal(isGreenExpired('green', completedAt, 15 * MINUTE, first + 21 * MINUTE), false,
    '刚完成的会话必须还绿着，而不是按首次完成时刻被判定过期')
})

test('turn/end 幂等：同会话同失败状态只记一条红（D-007）', () => {
  const document = emptyDocument()
  assert.equal(applyTurnEnd(document, 's1', { kind: 'blocked', at: 1000 }), true)
  // 宿主 turn 结束后仍轮询 inbox，被门禁挡下的会话会反复产生 blocked turn。
  assert.equal(applyTurnEnd(document, 's1', { kind: 'blocked', at: 2000 }), false)
  assert.equal(document.sessions.s1.lastTurnEnd.at, 1000, '重复的 blocked 不得刷新时间戳')
  // 状态指纹变化（原因不同）才是一条新的红。
  assert.equal(applyTurnEnd(document, 's1', { kind: 'error', message: 'boom', at: 3000 }), true)
  assert.equal(document.sessions.s1.lastTurnEnd.at, 3000)
})

test('turn/end 记录 kind 与 cause 与 message，不做语义判定', () => {
  const document = emptyDocument()
  applyTurnEnd(document, 's1', { kind: 'aborted', cause: 'parent', at: 10 })
  assert.deepEqual(document.sessions.s1.lastTurnEnd, { kind: 'aborted', cause: 'parent', at: 10 })
  applyTurnEnd(document, 's2', { kind: 'error', message: 'rate limited', at: 11 })
  assert.deepEqual(document.sessions.s2.lastTurnEnd, { kind: 'error', message: 'rate limited', at: 11 })
})

test('turn/start 记下重新开始执行，供客户端撤销红', () => {
  const document = emptyDocument()
  assert.equal(applyTurnStart(document, 's1', 500), true)
  assert.equal(applyTurnStart(document, 's1', 500), false)
  assert.equal(document.sessions.s1.turnStartAt, 500)
})

test('勾选已处理写入折叠时刻与当时颜色，取消则一并清空', () => {
  const document = emptyDocument()
  assert.equal(applyFold(document, 's1', 700, 'red'), true)
  assert.deepEqual(document.sessions.s1, { foldedAt: 700, foldedColor: 'red' })
  assert.equal(applyFold(document, 's1', 700, 'red'), false, '同值写入不应触发落盘')
  assert.equal(applyFold(document, 's1', 800, 'blue'), true)
  assert.equal(applyFold(document, 's1', undefined), true)
  assert.deepEqual(document.sessions.s1, {}, '取消折叠必须同时清掉颜色')
})

test('清理：只丢已完成且超期的记录，红色永不因超时被清', () => {
  const document = emptyDocument()
  const now = 100 * MINUTE
  applyTurnEnd(document, 'done-old', { kind: 'completed', at: now - 90 * MINUTE })
  applyTurnEnd(document, 'failed-old', { kind: 'error', message: 'x', at: now - 90 * MINUTE })
  applyTurnEnd(document, 'done-fresh', { kind: 'completed', at: now - 1 * MINUTE })
  applyFold(document, 'folded-old', now - 90 * MINUTE, 'green')
  pruneDocument(document, now, 30 * MINUTE)
  assert.equal(document.sessions['done-old'], undefined)
  assert.equal(document.sessions['done-fresh'] === undefined, false)
  assert.equal(document.sessions['failed-old'] === undefined, false, '红色不受保留时长约束')
  assert.equal(document.sessions['folded-old'] === undefined, false, '用户勾选过的记录不得静默丢弃')
})

test('清理：超过会话上限时保留最近活动的记录', () => {
  const document = emptyDocument()
  const now = 10_000_000
  for (let index = 0; index < 600; index += 1) {
    applyTurnEnd(document, `s${index}`, { kind: 'error', message: 'x', at: index })
  }
  pruneDocument(document, now, 30 * MINUTE)
  assert.equal(Object.keys(document.sessions).length, 500)
  assert.equal(document.sessions.s599 === undefined, false, '最新活动的记录必须保留')
  assert.equal(document.sessions.s0, undefined)
})

test('失败尾不得被后续正常结束覆盖（真实日志 error→aborted→completed）', () => {
  const document = emptyDocument()
  // 实测序列：会话 2c0c02f1 先 UNKNOWN_MODEL 失败，用户中止，再正常完成。
  // 旧实现只留 lastTurnEnd，completed 一来就把 error 彻底抹掉。
  applyTurnEnd(document, 's1', { kind: 'error', message: 'UNKNOWN_MODEL', at: 100 })
  applyTurnEnd(document, 's1', { kind: 'aborted', cause: 'user', at: 200 })
  assert.equal(document.sessions.s1.endsSinceCompletion.length, 2, '失败尾必须逐条保留')
  // completed 是失败尝试的结构性结束，不是 Host 的语义判定
  assert.equal(applyTurnEnd(document, 's1', { kind: 'completed', at: 300 }), true)
  assert.equal(document.sessions.s1.endsSinceCompletion, undefined, '完成后清空失败尾')
})

test('失败尾有上限，反复失败的会话不会无限增长', () => {
  const document = emptyDocument()
  for (let index = 0; index < 100; index += 1) {
    applyTurnEnd(document, 's1', { kind: 'error', message: `boom-${index}`, at: index })
  }
  assert.equal(document.sessions.s1.endsSinceCompletion.length, 32)
  assert.equal(document.sessions.s1.endsSinceCompletion.at(-1).message, 'boom-99', '保留最近的失败')
})

test('失败尾随落盘往返，损坏条目被丢弃', () => {
  const document = emptyDocument()
  applyTurnEnd(document, 's1', { kind: 'error', message: 'x', at: 10 })
  applyTurnEnd(document, 's1', { kind: 'blocked', at: 20 })
  const restored = parseDocument(serializeDocument(document))
  assert.deepEqual(restored, document)
  assert.deepEqual(
    parseDocument('{"sessions":{"a":{"endsSinceCompletion":[{"kind":"error","at":1},{"bad":1}]}}}'),
    { version: 1, sessions: { a: { endsSinceCompletion: [{ kind: 'error', at: 1 }] } } },
  )
})

test('落盘格式可往返，损坏与非法输入退化为空文档', () => {
  const document = emptyDocument()
  applyTurnEnd(document, 's1', { kind: 'completed', at: 42 })
  applyFold(document, 's1', 43, 'green')
  const restored = parseDocument(serializeDocument(document))
  assert.deepEqual(restored, document)

  assert.deepEqual(parseDocument('not json'), emptyDocument())
  assert.deepEqual(parseDocument('{"sessions": 3}'), emptyDocument())
  assert.deepEqual(parseDocument('{"sessions": {"a": {"lastTurnEnd": {"kind": 1}}}}'), emptyDocument())
  assert.deepEqual(
    parseDocument('{"sessions": {"a": {"foldedAt": "x", "lastTurnEnd": {"kind": "error", "at": 5}}}}'),
    { version: 1, sessions: { a: { lastTurnEnd: { kind: 'error', at: 5 } } } },
  )
})
