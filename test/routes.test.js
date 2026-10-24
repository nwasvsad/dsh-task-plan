import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PlanStore } from '../lib/plan.js'
import { createTaskPlanRoutes } from '../lib/routes.js'
import { timeOnDate } from '../lib/tier.js'

const DATE = '2026-10-22'
const NOW = timeOnDate(DATE, '18:00')

function makeReq(method, url, body, { raw = null } = {}) {
  const payload = raw !== null ? raw : body === undefined ? null : JSON.stringify(body)
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield Buffer.from(payload, 'utf8')
    },
  }
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = body
    },
    json() {
      return JSON.parse(this.body.toString('utf8'))
    },
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-routes-'))
  const store = new PlanStore({ dataDir: dir })
  await store.load()
  const task = await store.createTask({
    title: '原始任务',
    instruction: '原始说明',
    kind: 'dev',
    cwd: null,
    enabled: true,
  })
  const scheduler = {
    activeRun: null,
    conflictRun: false,
    startManual(ids) {
      if (this.conflictRun) return { error: 'conflict' }
      return { runId: 'run-1', date: DATE, taskIds: ids ?? [] }
    },
    cancel() {
      return { cancelled: true }
    },
  }
  const ctx = { connection: { requestRejection: () => undefined } }
  const config = {
    enabled: true,
    runAt: '18:00',
    offPeakOnly: true,
    autoRunEnabled: true,
    concurrency: 2,
    maxTasksPerRun: 20,
    defaultCwd: 'C:/work',
    currency: '¥',
    holidays: [],
    dataDir: dir,
  }
  const handler = createTaskPlanRoutes({
    ctx,
    store,
    scheduler,
    config,
    now: () => NOW,
  })
  return { dir, store, task, scheduler, ctx, handler }
}

async function call(handler, method, url, body, options) {
  const res = makeRes()
  await handler(makeReq(method, url, body, options), res)
  return res
}

test('GET state exposes tasks, schedule and config', async () => {
  const { dir, handler } = await setup()
  try {
    const res = await call(handler, 'GET', '/api/task-plan/state')
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.tasks.length, 1)
    assert.equal(body.date, DATE)
    assert.equal(body.offPeak, true)
    assert.equal(body.config.enabled, true)
    assert.ok(body.nextRunAt > 0)
    assert.equal('reports' in body, false)
    assert.equal('summary' in body, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('POST creates, PATCH updates, DELETE removes', async () => {
  const { dir, store, handler, task } = await setup()
  try {
    const created = await call(handler, 'POST', '/api/task-plan/tasks', {
      title: '新任务',
      instruction: '写点东西',
      kind: 'writing',
    })
    assert.equal(created.statusCode, 201)
    const createdTask = created.json().task
    assert.equal(store.state.tasks.length, 2)

    const patched = await call(handler, 'PATCH', '/api/task-plan/tasks', {
      id: createdTask.id,
      title: '改名',
      instruction: '新说明',
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(store.findTask(createdTask.id).title, '改名')

    const deleted = await call(handler, 'DELETE', `/api/task-plan/tasks?id=${task.id}`)
    assert.equal(deleted.statusCode, 200)
    assert.equal(store.findTask(task.id), undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a running task only accepts a title edit and cannot be deleted', async () => {
  const { dir, store, handler, task } = await setup()
  try {
    await store.mutate(() => {
      store.findTask(task.id).status = 'running'
    })
    const blocked = await call(handler, 'PATCH', '/api/task-plan/tasks', {
      id: task.id,
      instruction: '不允许',
    })
    assert.equal(blocked.statusCode, 409)
    const allowed = await call(handler, 'PATCH', '/api/task-plan/tasks', { id: task.id, title: '仅标题' })
    assert.equal(allowed.statusCode, 200)
    const deletion = await call(handler, 'DELETE', `/api/task-plan/tasks?id=${task.id}`)
    assert.equal(deletion.statusCode, 409)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('run, cancel and summary return accepted or conflict', async () => {
  const { dir, scheduler, handler } = await setup()
  try {
    const run = await call(handler, 'POST', '/api/task-plan/run', {})
    assert.equal(run.statusCode, 202)
    scheduler.conflictRun = true
    const conflict = await call(handler, 'POST', '/api/task-plan/run', {})
    assert.equal(conflict.statusCode, 409)

    const cancel = await call(handler, 'POST', '/api/task-plan/cancel', { taskId: 'x' })
    assert.equal(cancel.statusCode, 200)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the removed summary routes are gone', async () => {
  const { dir, handler } = await setup()
  try {
    assert.equal((await call(handler, 'POST', '/api/task-plan/summary', {})).statusCode, 404)
    assert.equal((await call(handler, 'GET', '/api/task-plan/reports')).statusCode, 404)
    assert.equal((await call(handler, 'GET', '/api/task-plan/report?date=2026-10-21')).statusCode, 404)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the connection fence rejects every route', async () => {
  const { dir, ctx, handler } = await setup()
  try {
    ctx.connection.requestRejection = () => 403
    const res = await call(handler, 'GET', '/api/task-plan/state')
    assert.equal(res.statusCode, 403)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('malformed input, oversized bodies and unknown routes are rejected', async () => {
  const { dir, handler } = await setup()
  try {
    const invalid = await call(handler, 'POST', '/api/task-plan/tasks', { title: 'x' })
    assert.equal(invalid.statusCode, 400)
    const huge = 'x'.repeat(70 * 1024)
    const oversized = await call(handler, 'POST', '/api/task-plan/tasks', null, {
      raw: JSON.stringify({ title: huge, instruction: huge }),
    })
    assert.equal(oversized.statusCode, 413)
    const unknown = await call(handler, 'GET', '/api/task-plan/nope')
    assert.equal(unknown.statusCode, 404)
    const wrongMethod = await call(handler, 'DELETE', '/api/task-plan/state')
    assert.equal(wrongMethod.statusCode, 404)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
