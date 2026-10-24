import assert from 'node:assert/strict'
import test from 'node:test'
import { Runner, taskPrompt } from '../lib/runner.js'
import { timeOnDate } from '../lib/tier.js'

const DATE = '2026-10-22'

function config(overrides = {}) {
  return {
    taskTimeoutMs: 5000,
    startTimeoutMs: 1000,
    pollIntervalMs: 500,
    defaultCwd: 'C:/work',
    agentPreset: null,
    holidays: [],
    concurrency: 2,
    summaryTimeoutMs: 5000,
    ...overrides,
  }
}

function assistantEvent(time, text, usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn: 1,
      step: 1,
      usage,
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text }] },
    },
  }
}

function makeFixture({ statuses, events, createError = null, childEvents = null }) {
  let step = 0
  let clock = 0
  const calls = []
  const agent = {
    get status() {
      return statuses[Math.min(step, statuses.length - 1)]
    },
  }
  const controller = {
    agent,
    calls,
    advance() {
      step += 1
      clock += 500
    },
    async create(request) {
      calls.push(['create', request])
      if (createError !== null) throw createError
      return { sessionId: 'session-1' }
    },
    async rename(request) {
      calls.push(['rename', request])
    },
    async prompt(request, signal) {
      calls.push(['prompt', request, signal])
    },
    async resolveAgent() {
      return { agent }
    },
    cancel(request) {
      calls.push(['cancel', request])
    },
    async list() {
      return { items: [] }
    },
  }
  const sessionQuery = {
    async observeSession(sessionId) {
      const selected = sessionId === 'child-1' && childEvents !== null ? childEvents : events
      return {
        events: selected,
        cursor: selected.length - 1,
        [Symbol.dispose]() {},
      }
    },
  }
  const subagents = {
    async listDescendants() {
      return childEvents === null ? [] : [{ kind: 'child', id: 'child-1', parentId: 'session-1', depth: 1 }]
    },
  }
  return {
    controller,
    sessionQuery,
    subagents,
    clock: () => clock,
    advance: () => controller.advance(),
  }
}

function makeRunner(fixture, overrides = {}) {
  return new Runner({
    sessionController: fixture.controller,
    sessionQuery: fixture.sessionQuery,
    subagents: fixture.subagents,
    config: config(overrides),
    now: fixture.clock,
    sleep: async () => {
      fixture.advance()
    },
  })
}

const task = {
  id: 'tsk_1',
  title: '修复登录 bug',
  instruction: '修复登录页面的空指针',
  kind: 'dev',
  cwd: null,
  enabled: true,
}

test('a completed turn records result, usage, cost and the session id', async () => {
  const started = timeOnDate(DATE, '12:00')
  const events = [
    { type: 'user/message', time: started, data: { source: { kind: 'user' }, content: [{ type: 'text', text: taskPrompt(task) }] } },
    assistantEvent(started + 1, '已完成：修复并加了测试', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 }),
    { type: 'turn/end', time: started + 2, data: { reason: { kind: 'completed' } } },
  ]
  const fixture = makeFixture({ statuses: ['idle', 'running', 'running', 'idle'], events })
  const runner = makeRunner(fixture)
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.equal(execution.status, 'done')
  assert.equal(execution.turnEnd, 'completed')
  assert.equal(execution.sessionId, 'session-1')
  assert.match(execution.result, /修复并加了测试/)
  assert.equal(execution.usage.inputTokens, 100)
  assert.equal(execution.usage.cacheReadTokens, 1000)
  assert.equal(execution.usage.outputTokens, 50)
  assert.equal(execution.usage.totalTokens, 1150)
  assert.ok(execution.cost.cny > 0)
  assert.deepEqual(execution.models, ['deepseek-flash'])
  assert.ok(fixture.controller.calls.some(([name]) => name === 'rename'))
  const promptCall = fixture.controller.calls.find(([name]) => name === 'prompt')
  assert.match(promptCall[1].content[0].text, /修复登录 bug/)
  assert.equal(promptCall[1].mode, 'queue')
})

test('a failed turn maps to a failed execution with its error', async () => {
  const started = timeOnDate(DATE, '12:00')
  const events = [
    assistantEvent(started, ''),
    {
      type: 'turn/end',
      time: started + 1,
      data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'rate limited' } } },
    },
  ]
  const fixture = makeFixture({ statuses: ['idle', 'running', 'idle'], events })
  const runner = makeRunner(fixture)
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.equal(execution.status, 'failed')
  assert.equal(execution.error.code, 'turn-error')
  assert.match(execution.error.message, /rate limited/)
})

test('a turn that never settles times out and cancels the session', async () => {
  const fixture = makeFixture({
    statuses: ['running'],
    events: [assistantEvent(0, 'partial')],
  })
  const runner = makeRunner(fixture, { taskTimeoutMs: 2000 })
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.equal(execution.status, 'failed')
  assert.equal(execution.error.code, 'timeout')
  assert.ok(fixture.controller.calls.some(([name]) => name === 'cancel'))
})

test('a prompt without a recorded turn fails as no-turn', async () => {
  const fixture = makeFixture({ statuses: ['idle'], events: [] })
  const runner = makeRunner(fixture, { startTimeoutMs: 500, taskTimeoutMs: 5000 })
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.equal(execution.status, 'failed')
  assert.equal(execution.error.code, 'no-turn')
})

test('session creation failure is reported without prompting', async () => {
  const fixture = makeFixture({
    statuses: ['idle'],
    events: [],
    createError: new Error('no model route'),
  })
  const runner = makeRunner(fixture)
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.equal(execution.status, 'failed')
  assert.equal(execution.error.code, 'session-create-failed')
  assert.match(execution.error.message, /no model route/)
  assert.equal(fixture.controller.calls.some(([name]) => name === 'prompt'), false)
})

test('cancellation wins over a running turn', async () => {
  const fixture = makeFixture({ statuses: ['running'], events: [assistantEvent(0, 'partial')] })
  const token = { cancelled: false }
  let sleeps = 0
  const runner = new Runner({
    sessionController: fixture.controller,
    sessionQuery: fixture.sessionQuery,
    subagents: fixture.subagents,
    config: config({ taskTimeoutMs: 60_000 }),
    now: fixture.clock,
    sleep: async () => {
      fixture.advance()
      sleeps += 1
      if (sleeps === 2) token.cancelled = true
    },
  })
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE, token })
  assert.equal(execution.status, 'cancelled')
  assert.equal(execution.error.code, 'cancelled')
  assert.ok(fixture.controller.calls.some(([name]) => name === 'cancel'))
})

test('child subagent usage rolls up into the task execution', async () => {
  const started = timeOnDate(DATE, '12:00')
  const events = [
    assistantEvent(started, 'root done', { inputTokens: 100, outputTokens: 10 }),
    { type: 'turn/end', time: started + 1, data: { reason: { kind: 'completed' } } },
  ]
  const childEvents = [
    assistantEvent(started, 'child done', { inputTokens: 200, outputTokens: 20 }),
  ]
  const fixture = makeFixture({ statuses: ['idle', 'running', 'idle'], events, childEvents })
  const runner = makeRunner(fixture)
  const execution = await runner.runOne(task, { runId: 'run-1', date: DATE })
  assert.deepEqual(execution.childSessionIds, ['child-1'])
  assert.equal(execution.usage.inputTokens, 300)
  assert.equal(execution.usage.outputTokens, 30)
})

test('runAll respects the concurrency limit and reports every task', async () => {
  const runner = new Runner({
    sessionController: {},
    sessionQuery: {},
    subagents: undefined,
    config: config({ concurrency: 2 }),
    now: () => 0,
    sleep: async () => {},
  })
  let active = 0
  let peak = 0
  runner.runOne = async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return { id: `exe-${item.id}`, taskId: item.id, status: 'done' }
  }
  const finished = []
  const results = await runner.runAll(
    [task, { ...task, id: 'tsk_2' }, { ...task, id: 'tsk_3' }],
    {
      runId: 'run-1',
      date: DATE,
      onFinish: async (item, execution) => finished.push([item.id, execution.id]),
    },
  )
  assert.equal(results.length, 3)
  assert.equal(peak, 2)
  assert.equal(finished.length, 3)
  assert.equal(runner.isActive(), false)
})

test('a queued task can be cancelled before a slot frees', async () => {
  const runner = new Runner({
    sessionController: {},
    sessionQuery: {},
    subagents: undefined,
    config: config({ concurrency: 1 }),
    now: () => 0,
    sleep: async () => {},
  })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  runner.runOne = async (item) => {
    await gate
    return { id: `exe-${item.id}`, taskId: item.id, status: 'done' }
  }
  const finished = []
  const promise = runner.runAll([task, { ...task, id: 'tsk_2' }], {
    runId: 'run-1',
    date: DATE,
    onFinish: async (item, execution) => finished.push(execution),
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runner.cancel('tsk_2'), true)
  assert.equal(runner.cancel('missing'), false)
  release()
  await promise
  const cancelled = finished.find((execution) => execution.taskId === 'tsk_2')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error.code, 'cancelled')
})
