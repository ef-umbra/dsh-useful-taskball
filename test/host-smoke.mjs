import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  apply,
  Config,
  DEFAULT_BUBBLE_DURATION_MS,
  DEFAULT_COMPLETION_RETENTION_MINUTES,
  describeTurnEnd,
  inject,
  name,
} from '../lib/index.js'

test('Server 端产物可冷启动加载，配置默认值有效', () => {
  assert.equal(name, 'dsh-useful-taskball')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
  assert.equal(DEFAULT_COMPLETION_RETENTION_MINUTES, 30)
  assert.equal(DEFAULT_BUBBLE_DURATION_MS, 2000)

  const parsed = Config({})
  assert.equal(parsed.completionRetentionMinutes.get(), 30)
  assert.equal(parsed.bubbleDurationMs.get(), 2000)
  // User 2026-11-03: the switch became a master gate for every state-change
  // bubble, so its default flipped to true. `false` would now mean "a fresh
  // install shows no bubble at all" — including a failure (D-002).
  assert.equal(parsed.bubbleOnCompletion.get(), true)
  assert.equal(parsed.showFoldedCount.get(), true)
  assert.throws(() => Config({ completionRetentionMinutes: 0 }))
})

test('turn/end 的 reason 被扁平化为可落盘记录，不做语义判定', () => {
  assert.deepEqual(describeTurnEnd({ turn: 3, reason: { kind: 'error', error: { message: 'boom' } } }, 7), {
    kind: 'error',
    message: 'boom',
    at: 7,
  })
  assert.deepEqual(describeTurnEnd({ turn: 3, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'x' } } }, 8), {
    kind: 'aborted',
    cause: 'hook',
    at: 8,
  })
  assert.deepEqual(describeTurnEnd({ turn: 3, reason: { kind: 'blocked' } }, 9), { kind: 'blocked', at: 9 })
  assert.equal(describeTurnEnd({ turn: 3 }, 9), undefined)
  assert.equal(describeTurnEnd(undefined, 9), undefined)
  assert.equal(describeTurnEnd({ reason: { kind: 42 } }, 9), undefined)
})

test('Server 端订阅 turn 事件并注册 RPC 通道，清理时不抛错', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'taskball-'))
  try {
    const listeners = new Map()
    const listenerOptions = new Map()
    const disposers = []
    const fetchRoutes = new Map()
    const injected = []
    const ctx = {
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
      get(name) {
        if (name === 'dshHomePath') return (...segments) => path.join(home, ...segments)
        if (name === 'connection') {
          return {
            fetch: {
              register(route) {
                fetchRoutes.set(route.path, route)
                return async () => {}
              },
            },
          }
        }
        return undefined
      },
      inject(deps, callback) {
        injected.push(deps)
        callback(ctx)
        return { dispose() {} }
      },
      logger: { warn() {} },
      on(event, listener, options) {
        listeners.set(event, listener)
        listenerOptions.set(event, options)
        return () => { listeners.delete(event) }
      },
      sessions: { list: () => [] },
    }

    apply(ctx)
    assert.ok(listeners.has('session/event'), '必须订阅 session/event 才能拿到红色与完成时刻')
    // `session/event` 是 scope-filtered dispatch：不带 global 只能收到自己 agent
    // context 里的会话。本插件没有 agent context，实测只看到 1 个会话，而实际
    // 6 个工作区有 14 个会话在跑 —— 跨会话聚合会彻底失效。
    assert.equal(listenerOptions.get('session/event')?.global, true, '订阅必须带 { global: true }')
    // 必须用 connection.fetch.register 注册**精确 Fetch 路由**。
    // `rpc.intercept('/api')` 是 dsh-api-gateway 独占的单槽：抢到它会让网关注册
    // 抛错且无日志，全部内置 Remote 端点 404 —— 实测把整个 Web UI 打挂。
    // `rpc.handle` 则因 owner 是 connection 自己的 ctx（无 webServer）而静默失败。
    assert.deepEqual(injected, [['connection']])
    assert.ok(fetchRoutes.has('/api/taskball/state'), '必须注册 /api/taskball/state 精确路由')
    assert.ok(fetchRoutes.has('/api/taskball/fold'), '必须注册 /api/taskball/fold 精确路由')
    assert.deepEqual([...fetchRoutes.get('/api/taskball/state').methods], ['POST'])

    const emit = listeners.get('session/event')
    emit({ id: 's1' }, { type: 'turn/end', time: 1000, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } })
    // 同状态重复的 blocked 不应刷新记录（D-007）。
    emit({ id: 's2' }, { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'blocked' } } })
    emit({ id: 's2' }, { type: 'turn/end', time: 3000, data: { turn: 2, reason: { kind: 'blocked' } } })
    emit({ id: 's3' }, { type: 'turn/end', time: 4000, data: { turn: 1, reason: { kind: 'completed' } } })
    emit({ id: '', }, { type: 'turn/end', time: 5000, data: { reason: { kind: 'error' } } })
    emit({ id: 's4' }, { type: 'turn/start', time: 6000, data: { turn: 2 } })

    const state = await fetchRoutes.get('/api/taskball/state').fetch(new Request('http://x/api/taskball/state', { method: 'POST' }))
    const stateBody = await state.json()
    assert.equal(stateBody.ok, true)
    assert.equal(stateBody.value.retentionMs, 30 * 60_000)
    assert.equal(stateBody.value.sessions.s1.lastTurnEnd.kind, 'error')
    assert.equal(stateBody.value.sessions.s1.lastTurnEnd.message, 'boom')
    assert.equal(stateBody.value.sessions.s2.lastTurnEnd.at, 2000, '重复的 blocked 不得刷新时间戳')
    assert.equal(stateBody.value.sessions.s3.lastTurnEnd.kind, 'completed')
    assert.equal(stateBody.value.sessions.s4.turnStartAt, 6000)
    assert.equal(stateBody.value.sessions[''], undefined)

    const foldRoute = fetchRoutes.get('/api/taskball/fold')
    const folded = await (await foldRoute.fetch(new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', color: 'red', folded: true }),
    }))).json()
    assert.equal(folded.ok, true)
    assert.equal(typeof folded.value.foldedAt, 'number')
    const unfolded = await (await foldRoute.fetch(new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', folded: false }),
    }))).json()
    assert.equal(unfolded.value.foldedAt, null)
    const bad = await (await foldRoute.fetch(new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))).json()
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad-request')

    for (const dispose of disposers) assert.doesNotThrow(dispose)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('绝不可占用 /api interceptor（回归：曾把宿主全部 Remote 端点打成 404）', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'taskball-'))
  try {
    const touched = []
    // `/api` 是 dsh-api-gateway 独占的**单槽** interceptor：`registerInterceptor`
    // 遇到已占用直接 throw；若插件抢先注册，网关的注册在子 fiber 里抛错且无日志，
    // 全部内置 Remote 端点落到兜底 404 —— 实测整个 Web UI 瘫痪（2026-10-27）。
    // 因此这里把 rpc 的每个入口都记下来，断言一个都没被碰过。
    const ctx = {
      effect(callback) {
        callback()
        return () => {}
      },
      get(name) {
        if (name === 'dshHomePath') return (...segments) => path.join(home, ...segments)
        if (name === 'connection') {
          return {
            rpc: {
              handle() { touched.push('rpc.handle'); return async () => {} },
              intercept() { touched.push('rpc.intercept'); return async () => {} },
            },
            fetch: {
              register(route) {
                touched.push(`fetch.register:${route.path}`)
                return async () => {}
              },
            },
          }
        }
        return undefined
      },
      inject(deps, callback) {
        callback(ctx)
        return { dispose() {} }
      },
      logger: { warn() {} },
      on() { return () => {} },
      sessions: { list: () => [] },
    }
    apply(ctx)
    assert.equal(touched.some((x) => x.startsWith('rpc.')), false, '不得触碰任何 rpc 入口')
    assert.deepEqual(touched.sort(), [
      'fetch.register:/api/taskball/fold',
      'fetch.register:/api/taskball/state',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Client 端产物注册真实 slot、使用 connection 并只 require react', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = []
  let client
  const window = {
    __ModuleLoader__: {
      load(definition) {
        client = definition.factory((specifier) => {
          if (specifier === 'react') return React
          throw new Error(`Unexpected require: ${specifier}`)
        })
      },
    },
  }
  vm.runInNewContext(source, { window })
  assert.equal(client.name, 'dsh-useful-taskball')
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'uiWorkspace', 'configForms'])
  const effectDisposers = []
  const localeRegistrations = []
  const injectDisposers = []
  const configFormRequests = []
  const ctx = {
    get: (key) => (key === 'connection'
      ? { rpc: { call: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) } }
      : undefined),
    uiWorkspace: { openSession() {} },
    configForms: {
      get(entryId) {
        configFormRequests.push(entryId)
        return {
          getSnapshot: () => ({
            status: 'ready',
            value: { completionRetentionMinutes: 30, bubbleDurationMs: 2000, bubbleOnCompletion: true, showFoldedCount: true },
            base: {},
            user: {},
            revision: 1,
            writable: true,
          }),
          subscribe: () => () => {},
          mutate: async () => true,
          set: async () => true,
          unset: async () => true,
          dispose: () => {},
        }
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(_key, callback) {
        callback()
        const dispose = () => {}
        injectDisposers.push(dispose)
        return dispose
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(registrations.map(({ options }) => options.name).sort(), [
    'plugins.bundle.config',
    'shell.overlay',
  ])
  const overlay = registrations.find(({ options }) => options.name === 'shell.overlay')
  const config = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  assert.equal(overlay.options.id, 'dsh-useful-taskball')
  assert.equal(config.options.key, 'dsh-useful-taskball')
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, 'taskball')
  assert.equal(localeRegistrations[0].dictionaries.zh['ball.empty'], '暂无任务状态')
  assert.equal(localeRegistrations[0].dictionaries.en['ball.empty'], 'No active task states')
  // style + locale：样式注入必须存在，否则动效与 corner-shape 复位全失效。
  // 共享 form 不在此列 —— 它归 configForms provider 所有，本插件不得注册 disposer（B-003）。
  assert.equal(effectDisposers.length, 2)
  assert.equal(injectDisposers.length, 2)
  assert.deepEqual(configFormRequests, ['dsh-useful-taskball'])

  const t = (key) => key
  const sessionsState = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', title: '修复登录', displayTitle: '修复登录', blank: false, updatedAt: 1 },
      s2: { id: 's2', title: '写文档', displayTitle: '写文档', blank: false, updatedAt: 2 },
    },
  }
  const statusMap = new Map([
    ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['s2', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ])
  const workspaceState = {
    items: [{ workspaceId: 'w1', path: '/w1', title: '项目一', sessionIds: ['s1', 's2'] }],
  }
  const hostProps = {
    t,
    useSessions: (selector) => selector(sessionsState),
    useSessionStatus: (selector) => selector(statusMap),
    useWorkspaces: (selector) => selector(workspaceState),
  }
  const overlayMarkup = renderToStaticMarkup(React.createElement(overlay.component, hostProps))
  assert.ok(overlayMarkup.includes('data-taskball-ball'))
  assert.ok(overlayMarkup.includes('aria-label'))

  const settingsMarkup = renderToStaticMarkup(React.createElement(config.component, { ...hostProps, view: 'page' }))
  // F-011: the page now opens on the Appearance tab, so the field this smoke
  // check looks for must be one of ITS fields; the retention field moved to
  // Notifications and is asserted by the settings tests instead.
  assert.ok(settingsMarkup.includes('settings.statusMarker.label'))

  for (const dispose of injectDisposers) assert.doesNotThrow(dispose)
})
