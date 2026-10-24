import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, resolveConfig } from '../lib/index.js'

function makeReq(method, url) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {},
  }
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
  }
}

test('apply registers the prefix route and serves state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-plan-apply-'))
  const routes = []
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    sessionController: {
      async list() {
        return { items: [] }
      },
      async create() {
        return { sessionId: 'session-1' }
      },
      async rename() {},
      async prompt() {},
      async resolveAgent() {
        return { agent: { status: 'idle' } }
      },
      cancel() {},
    },
    sessionQuery: {
      async observeSession() {
        return { events: [], cursor: -1, [Symbol.dispose]() {} }
      },
    },
    subagents: {},
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const disposable = fn()
      if (typeof disposable === 'function') disposers.push(disposable)
      return disposable
    },
    interval() {
      return () => {}
    },
    timeout() {
      return () => {}
    },
  }
  try {
    await apply(ctx, {
      dataDir: dir,
      defaultCwd: 'C:/work',
      autoRunEnabled: false,
    })
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/api/task-plan')
    const res = makeRes()
    await routes[0].handler(makeReq('GET', '/api/task-plan/state'), res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body.toString('utf8'))
    assert.equal(body.tasks.length, 0)
    assert.equal(body.config.enabled, true)
    assert.equal(body.config.autoRunEnabled, false)
    const files = await fs.readdir(dir)
    assert.ok(files.includes('plan.json') === false, 'state is not persisted until a mutation')
    assert.ok(files.includes('reports') === false, 'the plan package creates no digest directory')
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // Test teardown is best-effort.
      }
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveConfig clamps hostile values and keeps absolute paths', () => {
  const config = resolveConfig({
    dataDir: 'relative-dir',
    defaultCwd: 'relative-cwd',
    runAt: 'bogus',
    concurrency: 99,
    maxTasksPerRun: 0,
    holidays: ['2026-10-01', 'bad', '2026-10-01'],
    currency: 'CNY¥',
  })
  assert.equal(config.runAt, '18:00')
  assert.equal(config.concurrency, 8)
  assert.equal(config.maxTasksPerRun, 1)
  assert.deepEqual(config.holidays, ['2026-10-01'])
  assert.ok(path.isAbsolute(config.dataDir))
  assert.ok(path.isAbsolute(config.defaultCwd))
  assert.equal(config.currency, 'CNY¥')
})
