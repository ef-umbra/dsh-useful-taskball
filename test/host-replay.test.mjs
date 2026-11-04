import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createReplayRunner,
  emptyDocument,
  foldSessionEvents,
  parseDocument,
  replayOnce,
  serializeDocument,
} from '../lib/index.js'

const MINUTE = 60_000
const NOW = 1_800_000_000_000

/** A persisted log as `sessionQuery.readSession` returns it: closers included. */
function log(events) {
  return { session: { id: 's1' }, events }
}

function record(overrides = {}) {
  return { header: { createdAt: NOW, id: 's1' }, live: false, ...overrides }
}

function source(records, logs) {
  return {
    async listSessions() { return records },
    async readSession(id) {
      const snapshot = logs[id]
      if (snapshot === undefined) throw new Error(`no log for ${id}`)
      return snapshot
    },
  }
}

test('回放：孤儿 turn 的 interrupted closer 被折叠成红（D-027）', async () => {
  const document = emptyDocument()
  let touched = 0
  // The Host already synthesized the closer during its cold read. Replay must
  // consume it as an ordinary turn/end, never re-derive the marker itself.
  const events = [
    { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
    { type: 'turn/end', seq: 9, time: NOW - 4000, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
  const result = await replayOnce({
    document,
    now: NOW,
    source: source([record()], { s1: log(events) }),
    touch: () => { touched += 1 },
  })
  assert.equal(result.changed, 1)
  assert.equal(touched, 1)
  assert.equal(document.sessions.s1.lastTurnEnd.kind, 'interrupted')
  assert.equal(document.sessions.s1.replayedThroughSeq, 9)
})

test('回放：已折叠过的事件不重复处理（seq 游标幂等）', async () => {
  const document = emptyDocument()
  const events = [
    { type: 'turn/start', seq: 1, time: NOW - 5000, data: { turn: 1 } },
    { type: 'turn/end', seq: 9, time: NOW - 4000, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
  const deps = {
    document,
    now: NOW,
    source: source([record()], { s1: log(events) }),
    touch: () => {},
  }
  await replayOnce(deps)
  const first = JSON.parse(serializeDocument(document))
  const second = await replayOnce(deps)
  assert.equal(second.changed, 0, '第二次回放不得再改文档')
  assert.deepEqual(JSON.parse(serializeDocument(document)), first, '文档必须完全不变')
})

test('回放：游标用 seq 而不是 time（synthetic closer 复用最后一条真实事件的时间）', async () => {
  const document = emptyDocument()
  // repair.d.ts: "timestamps reuse the last real event" — so a closer can carry
  // the SAME `time` as the event before it. A timestamp cursor would treat the
  // second turn as already seen and skip it. The two closers use different kinds
  // on purpose: two identical ones are deduped by D-007 before they reach the
  // tail, which would hide what this test is measuring.
  const events = [
    { type: 'turn/start', seq: 1, time: 5000, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 5000, data: { turn: 1, reason: { kind: 'interrupted' } } },
    { type: 'turn/start', seq: 3, time: 5000, data: { turn: 2 } },
    { type: 'turn/end', seq: 4, time: 5000, data: { turn: 2, reason: { kind: 'blocked' } } },
  ]
  foldSessionEvents(document, 's1', events, -1)
  assert.equal(document.sessions.s1.endsSinceCompletion.length, 2, '两条同时间戳、不同 seq 的 closer 都必须折叠')
  assert.equal(document.sessions.s1.replayedThroughSeq, undefined, 'foldSessionEvents 本身不写游标')
})

test('回放：live 会话跳过（实时订阅已经覆盖）', async () => {
  const document = emptyDocument()
  const result = await replayOnce({
    document,
    now: NOW,
    source: source([record({ live: true })], { s1: log([]) }),
    touch: () => {},
  })
  assert.equal(result.inspected, 0)
  assert.equal(result.changed, 0)
})

test('回放：超出回看窗口的旧会话不读（避免把早已收尾的失败复活成红）', async () => {
  const document = emptyDocument()
  const old = { header: { createdAt: NOW - 30 * 24 * 60 * MINUTE, id: 's1' }, live: false }
  const result = await replayOnce({
    document,
    now: NOW,
    source: source([old], { s1: log([{ type: 'turn/end', seq: 1, time: 1, data: { reason: { kind: 'interrupted' } } }]) }),
    touch: () => {},
  })
  assert.equal(result.inspected, 0, '30 天前的会话不进入回放')
})

test('回放：单会话读取失败被隔离，不影响其他会话', async () => {
  const document = emptyDocument()
  const good = [{ type: 'turn/end', seq: 3, time: NOW, data: { turn: 1, reason: { kind: 'interrupted' } } }]
  const result = await replayOnce({
    document,
    now: NOW,
    source: source(
      [record({ header: { createdAt: NOW, id: 'bad' } }), record({ header: { createdAt: NOW - 1000, id: 's1' } })],
      { s1: log(good) },
    ),
    touch: () => {},
  })
  assert.equal(result.failed, 1, '损坏日志计入 failed')
  assert.equal(result.changed, 1, '正常会话仍然回放成功')
  assert.equal(document.sessions.s1.lastTurnEnd.kind, 'interrupted')
  assert.equal(document.sessions.bad, undefined, '失败会话不得留下空壳记录')
})

test('回放：listSessions 抛错时不改文档、不抛出', async () => {
  const document = emptyDocument()
  const result = await replayOnce({
    document,
    now: NOW,
    source: {
      async listSessions() { throw new Error('corpus down') },
      async readSession() { throw new Error('unreachable') },
    },
    touch: () => { throw new Error('touch must not run') },
  })
  assert.deepEqual(result, { inspected: 0, changed: 0, failed: 0 })
  assert.deepEqual(Object.keys(document.sessions), [])
})

test('回放：每次只读预算内的会话，轮转覆盖全量', async () => {
  const document = emptyDocument()
  const records = Array.from({ length: 5 }, (_, index) =>
    record({ header: { createdAt: NOW - index * 1000, id: `s${index}` } }))
  const logs = Object.fromEntries(records.map((item) => [
    item.header.id,
    log([{ type: 'turn/end', seq: 1, time: NOW, data: { turn: 1, reason: { kind: 'interrupted' } } }]),
  ]))
  const seen = []
  const deps = {
    document,
    now: NOW,
    budget: 2,
    source: {
      async listSessions() { return records },
      async readSession(id) { seen.push(id); return logs[id] },
    },
    touch: () => {},
  }
  const run = createReplayRunner(deps)
  await run()
  assert.equal(seen.length, 2, '第一趟只读预算内的 2 个')
  await run()
  assert.equal(seen.length, 4, '第二趟接着读，不重复已读的')
  await run()
  assert.equal(seen.length, 5, '第三趟读完剩下的 1 个')
  await run()
  assert.equal(seen.length, 7, '周期结束后重新从头覆盖')
})

test('回放：游标不是可渲染事实，只有游标的记录在解析时被丢弃', () => {
  const text = JSON.stringify({
    version: 1,
    sessions: {
      onlyCursor: { replayedThroughSeq: 12 },
      withFact: { replayedThroughSeq: 12, lastTurnEnd: { kind: 'interrupted', at: 5 } },
    },
  })
  const document = parseDocument(text)
  assert.equal(document.sessions.onlyCursor, undefined, '只有游标的记录不得占用文件')
  assert.equal(document.sessions.withFact.lastTurnEnd.kind, 'interrupted')
  assert.equal(document.sessions.withFact.replayedThroughSeq, 12, '游标随记录一起往返')
})
