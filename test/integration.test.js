import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PlanStore } from '../lib/plan.js'
import { Runner } from '../lib/runner.js'
import { Scheduler } from '../lib/scheduler.js'
import { timeOnDate } from '../lib/tier.js'

const DATE = '2026-10-22'

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('the real runner and scheduler complete a task end to end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-integration-'))
  let clock = timeOnDate(DATE, '18:00')
  let step = 0
  const statuses = ['idle', 'running', 'running', 'idle']
  const agent = {
    get status() {
      return statuses[Math.min(step, statuses.length - 1)]
    },
  }
  const calls = []
  const controller = {
    async create() {
      calls.push('create')
      return { sessionId: 'session-it' }
    },
    async rename() {
      calls.push('rename')
    },
    async prompt() {
      calls.push('prompt')
    },
    async resolveAgent() {
      return { agent }
    },
    cancel() {
      calls.push('cancel')
    },
    async list() {
      return { items: [] }
    },
  }
  const events = [
    {
      type: 'assistant/message',
      time: clock,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
        message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: '完成' }] },
      },
    },
    { type: 'turn/end', time: clock + 1, data: { reason: { kind: 'completed' } } },
  ]
  const sessionQuery = {
    async observeSession() {
      return { events, cursor: 1, [Symbol.dispose]() {} }
    },
  }
  try {
    const store = new PlanStore({ dataDir: dir })
    await store.load()
    const task = await store.createTask({
      title: '集成任务',
      instruction: '跑通一次',
      kind: 'dev',
      cwd: null,
      enabled: true,
    })
    const config = {
      enabled: true,
      autoRunEnabled: true,
      runAt: '18:00',
      offPeakOnly: true,
      holidays: [],
      maxTasksPerRun: 20,
      concurrency: 2,
      taskTimeoutMs: 5000,
      startTimeoutMs: 1000,
      pollIntervalMs: 500,
      defaultCwd: 'C:/work',
      agentPreset: null,
    }
    const runner = new Runner({
      sessionController: controller,
      sessionQuery,
      subagents: {},
      config,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        step += 1
      },
    })
    const scheduler = new Scheduler({
      store,
      runner,
      config,
      now: () => clock,
    })
    await scheduler.tick()
    assert.ok(scheduler.activeRun)
    await waitFor(() => scheduler.activeRun === null)
    const live = store.findTask(task.id)
    assert.equal(live.status, 'done')
    assert.equal(live.lastRun.sessionId, 'session-it')
    assert.equal(live.lastRun.usage.totalTokens, 150)
    assert.ok(live.lastRun.cost.cny > 0)
    assert.equal(store.state.meta.lastAutoRunDate, DATE)
    assert.equal(store.state.executions.length, 1)
    assert.deepEqual(calls.slice(0, 3), ['create', 'rename', 'prompt'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
