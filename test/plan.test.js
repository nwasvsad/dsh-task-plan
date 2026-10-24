import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_EXECUTIONS,
  PlanStore,
  normalizeState,
  validateCreateTask,
  validateTaskPatch,
} from '../lib/plan.js'

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-store-'))
  const store = new PlanStore({ dataDir: dir })
  await store.load()
  return { dir, store }
}

const baseTask = {
  title: '整理日报',
  instruction: '把今天的会话整理成日报',
  kind: 'writing',
  cwd: null,
  enabled: true,
}

test('create, reload, update and delete a task', async () => {
  const { dir, store } = await tempStore()
  try {
    const task = await store.createTask(baseTask)
    assert.match(task.id, /^tsk_/)
    assert.equal(task.status, 'pending')
    assert.equal(store.state.tasks.length, 1)

    const reloaded = new PlanStore({ dataDir: dir })
    await reloaded.load()
    assert.equal(reloaded.state.tasks.length, 1)
    assert.equal(reloaded.state.tasks[0].title, baseTask.title)

    const updated = await reloaded.updateTask(task.id, { title: '新标题', enabled: false })
    assert.equal(updated.title, '新标题')
    assert.equal(updated.enabled, false)

    await reloaded.deleteTask(task.id)
    assert.equal(reloaded.state.tasks.length, 0)
    await assert.rejects(() => reloaded.deleteTask(task.id), (error) => error.code === 'not_found')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('validation rejects unsafe or empty input', () => {
  assert.equal(validateCreateTask({ ...baseTask, title: ' ' }).ok, false)
  assert.equal(validateCreateTask({ ...baseTask, instruction: '' }).ok, false)
  assert.equal(validateCreateTask({ ...baseTask, kind: 'nope' }).ok, false)
  assert.equal(validateCreateTask({ ...baseTask, cwd: 'relative' }).ok, false)
  assert.equal(validateCreateTask({ ...baseTask, enabled: 'yes' }).ok, false)
  assert.equal(validateCreateTask({ ...baseTask, cwd: 'C:/work' }).ok, true)

  assert.equal(validateTaskPatch({ id: 'x' }).ok, false)
  assert.equal(validateTaskPatch({ id: 'x', title: 'ok' }).ok, true)
  assert.equal(validateTaskPatch({ id: 'x', cwd: null }).ok, true)
  assert.equal(validateTaskPatch({ id: 'x', kind: 'ops' }).ok, true)
})

test('concurrent mutations serialize without losing tasks', async () => {
  const { dir, store } = await tempStore()
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.createTask({ ...baseTask, title: `任务 ${index}` }),
      ),
    )
    assert.equal(store.state.tasks.length, 20)
    const reloaded = new PlanStore({ dataDir: dir })
    await reloaded.load()
    assert.equal(reloaded.state.tasks.length, 20)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('execution history binds to the task and is bounded', async () => {
  const { dir, store } = await tempStore()
  try {
    const task = await store.createTask(baseTask)
    await store.mutate((state) => {
      for (let index = 0; index < MAX_EXECUTIONS; index += 1) {
        state.executions.push({ id: `old-${index}`, taskId: task.id, date: '2026-10-01' })
      }
    })
    const execution = {
      id: 'exe-1',
      runId: 'run-1',
      date: '2026-10-22',
      taskId: task.id,
      taskTitle: task.title,
      kind: task.kind,
      status: 'done',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
    }
    await store.recordExecution(execution)
    assert.equal(store.state.executions.length, MAX_EXECUTIONS)
    assert.equal(store.state.executions.at(-1).id, 'exe-1')
    assert.equal(store.findTask(task.id).status, 'done')
    assert.equal(store.findTask(task.id).lastRun.id, 'exe-1')
    assert.equal(store.executionsForDate('2026-10-22').length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt plan.json is backed up and the store starts empty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-bad-'))
  try {
    const file = path.join(dir, 'plan.json')
    await fs.writeFile(file, '{ not json', 'utf8')
    const store = new PlanStore({ dataDir: dir, now: () => 12345 })
    await store.load()
    assert.equal(store.state.tasks.length, 0)
    assert.ok(store.warnings.some((warning) => warning.includes('unreadable')))
    const files = await fs.readdir(dir)
    assert.ok(files.some((name) => name.startsWith('plan.json.corrupt-')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('normalizeState drops invalid records and keeps valid ones', () => {
  const warnings = []
  const state = normalizeState(
    {
      version: 99,
      tasks: [
        { id: 'a', title: 'A', instruction: 'do it', status: 'weird', kind: 'weird' },
        { id: '', title: 'bad', instruction: 'x' },
        null,
      ],
      executions: [{ id: 'e', taskId: 'a' }, null],
      meta: { lastAutoRunDate: 7, lastSummaryDate: '2026-10-01' },
    },
    (message) => warnings.push(message),
  )
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].status, 'pending')
  assert.equal(state.tasks[0].kind, 'other')
  assert.equal(state.executions.length, 1)
  assert.equal(state.meta.lastAutoRunDate, null)
  assert.equal(state.meta.lastSummaryDate, '2026-10-01')
  assert.ok(warnings.length >= 2)
})
