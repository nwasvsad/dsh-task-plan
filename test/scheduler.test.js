import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PlanStore } from '../lib/plan.js'
import { Scheduler } from '../lib/scheduler.js'
import { timeOnDate, addDays } from '../lib/tier.js'

const THURSDAY = '2026-10-22'
const FRIDAY = '2026-10-23'

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function setup(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-sched-'))
  const store = new PlanStore({ dataDir: dir })
  await store.load()
  const clock = { value: options.now ?? timeOnDate(THURSDAY, '17:00') }
  const config = {
    enabled: true,
    autoRunEnabled: options.autoRunEnabled ?? true,
    runAt: options.runAt ?? '18:00',
    offPeakOnly: options.offPeakOnly ?? true,
    holidays: [],
    maxTasksPerRun: 20,
    concurrency: 2,
  }
  const executions = []
  const runner = {
    cancelled: [],
    activeIds: new Set(),
    async runAll(tasks, { runId, date, onQueued, onStart, onFinish }) {
      for (const task of tasks) {
        this.activeIds.add(task.id)
        try {
          await onQueued?.(task)
          await onStart?.(task)
          const execution = {
            id: `exe_${task.id}_${runId}`,
            runId,
            date,
            taskId: task.id,
            taskTitle: task.title,
            kind: task.kind,
            status: 'done',
            turnEnd: 'completed',
            error: null,
            result: 'ok',
            sessionId: `session-${task.id}`,
            childSessionIds: [],
            startedAt: clock.value,
            finishedAt: clock.value + 10,
            durationMs: 10,
            usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 15 },
            cost: { cny: 0.0001, peakCny: 0, offPeakCny: 0.0001, unknownModels: [] },
            models: ['deepseek-flash'],
          }
          executions.push(execution)
          await onFinish?.(task, execution)
        } finally {
          this.activeIds.delete(task.id)
        }
      }
      return executions
    },
    cancel(taskId) {
      if (!this.activeIds.has(taskId)) return false
      this.cancelled.push(taskId)
      return true
    },
    isActive() {
      return this.activeIds.size > 0
    },
  }
  const scheduler = new Scheduler({
    store,
    runner,
    config,
    now: () => clock.value,
  })
  return { dir, store, runner, scheduler, clock, config }
}

const taskInput = {
  title: '生成日报',
  instruction: '把今天的会话整理成日报',
  kind: 'writing',
  cwd: null,
  enabled: true,
}

test('automatic run fires once at the off-peak time and records the execution', async () => {
  const { dir, store, scheduler, clock } = await setup()
  try {
    const task = await store.createTask(taskInput)
    clock.value = timeOnDate(THURSDAY, '18:00')
    await scheduler.tick()
    assert.ok(scheduler.activeRun)
    await waitFor(() => scheduler.activeRun === null)
    assert.equal(store.state.meta.lastAutoRunDate, THURSDAY)
    assert.equal(store.findTask(task.id).status, 'done')
    assert.equal(store.state.executions.length, 1)
    assert.equal(store.state.executions[0].status, 'done')

    clock.value = timeOnDate(THURSDAY, '18:30')
    await scheduler.tick()
    await waitFor(() => scheduler.activeRun === null)
    assert.equal(store.state.executions.length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a peak runAt defers to the off-peak boundary', async () => {
  const { dir, store, scheduler, clock } = await setup({ runAt: '10:00' })
  try {
    await store.createTask(taskInput)
    clock.value = timeOnDate(THURSDAY, '10:00')
    await scheduler.tick()
    assert.equal(scheduler.activeRun, null)
    assert.equal(store.state.meta.lastAutoRunDate, null)
    assert.equal(store.state.tasks[0].status, 'pending')

    clock.value = timeOnDate(THURSDAY, '12:00')
    await scheduler.tick()
    await waitFor(() => scheduler.activeRun === null)
    assert.equal(store.state.meta.lastAutoRunDate, THURSDAY)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('no pending task means no automatic run', async () => {
  const { dir, store, scheduler, clock } = await setup()
  try {
    clock.value = timeOnDate(THURSDAY, '19:00')
    await scheduler.tick()
    assert.equal(scheduler.activeRun, null)
    assert.equal(store.state.meta.lastAutoRunDate, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a manual run does not consume the automatic daily slot', async () => {
  const { dir, store, scheduler } = await setup()
  try {
    const task = await store.createTask(taskInput)
    const started = scheduler.startManual([task.id])
    assert.ok(started.runId)
    await waitFor(() => scheduler.activeRun === null)
    assert.equal(store.state.meta.lastAutoRunDate, null)
    assert.equal(store.state.executions.length, 1)
    assert.equal(scheduler.startManual([]).error, 'no-tasks')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('recover marks queued/running tasks interrupted and records a synthetic execution', async () => {
  const { dir, store, scheduler } = await setup()
  try {
    const task = await store.createTask(taskInput)
    await store.mutate(() => {
      store.findTask(task.id).status = 'running'
    })
    const count = await scheduler.recover()
    assert.equal(count, 1)
    assert.equal(store.findTask(task.id).status, 'interrupted')
    assert.equal(store.state.executions.length, 1)
    assert.equal(store.state.executions[0].status, 'interrupted')
    assert.equal(await scheduler.recover(), 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('cancel reports unknown and idle tasks distinctly', async () => {
  const { dir, store, scheduler } = await setup()
  try {
    const task = await store.createTask(taskInput)
    assert.equal(scheduler.cancel('missing').error, 'not_found')
    assert.equal(scheduler.cancel(task.id).error, 'not_running')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
