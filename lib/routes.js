/**
 * Authenticated HTTP surface for the task-plan page.
 *
 * @module dsh-task-plan/routes
 */
import { beijingDate, nextScheduledRun, tierAt } from './tier.js'
import { KINDS, validateCreateTask, validateTaskPatch } from './plan.js'

const PREFIX = '/api/task-plan'
const MAX_BODY_BYTES = 64 * 1024

/** One request failure with an HTTP status and stable code. */
class RequestError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} code Stable code.
   * @param {string} message Human message.
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Send one JSON response.
 * @param {object} res Node response.
 * @param {number} status HTTP status.
 * @param {object} payload JSON body.
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.byteLength))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read and parse one bounded JSON request body.
 * @param {object} req Node request.
 * @returns {Promise<object>}
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'body_too_large', 'request body exceeds 64KB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw new RequestError(400, 'invalid_json', String(error?.message ?? error))
  }
}

/**
 * Build the state snapshot the browser polls.
 * @param {object} input Services and clock.
 * @returns {object}
 */
export function buildState({ store, scheduler, config, now }) {
  const holidays = config.holidays
  const date = beijingDate(now)
  const tasks = store.state.tasks.map((task) => ({ ...task }))
  const hasPending = tasks.some((task) => task.enabled && task.status === 'pending')
  return {
    now,
    date,
    offPeak: tierAt(now, holidays) === 'offPeak',
    nextRunAt: nextScheduledRun({
      now,
      runAt: config.runAt,
      offPeakOnly: config.offPeakOnly,
      holidays,
      lastAutoRunDate: store.state.meta.lastAutoRunDate,
      hasPending,
    }),
    run: scheduler.activeRun === null ? null : { ...scheduler.activeRun },
    tasks,
    warnings: [...store.warnings],
    config: {
      enabled: config.enabled,
      runAt: config.runAt,
      offPeakOnly: config.offPeakOnly,
      autoRunEnabled: config.autoRunEnabled,
      concurrency: config.concurrency,
      maxTasksPerRun: config.maxTasksPerRun,
      defaultCwd: config.defaultCwd,
      currency: config.currency,
      kinds: KINDS,
      dataDir: config.dataDir,
    },
  }
}

/**
 * Create the route handler.
 * @param {object} options Route options.
 * @param {object} options.ctx Host context (for the connection fence).
 * @param {object} options.store Plan store.
 * @param {object} options.scheduler Scheduler.
 * @param {object} options.config Normalized config.
 * @param {object} [options.logger] Host logger.
 * @param {() => number} [options.now] Clock.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createTaskPlanRoutes({ ctx, store, scheduler, config, logger, now = Date.now }) {
  return async function taskPlanRoutes(req, res) {
    const rejection = ctx.connection?.requestRejection?.(req)
    if (rejection !== undefined) {
      sendJson(res, Number(rejection) || 403, { code: 'rejected', message: 'request rejected by the connection fence' })
      return
    }

    let url
    try {
      url = new URL(String(req.url), 'http://localhost')
    } catch {
      sendJson(res, 400, { code: 'invalid_request', message: 'invalid URL' })
      return
    }
    if (!url.pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { code: 'not_found', message: 'unknown route' })
      return
    }
    const route = url.pathname
      .slice(PREFIX.length)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    const method = req.method ?? 'GET'

    try {
      if (route === 'state' && method === 'GET') {
        sendJson(res, 200, buildState({ store, scheduler, config, now: now() }))
        return
      }
      if (route === 'tasks' && method === 'POST') {
        const body = await readJsonBody(req)
        const validated = validateCreateTask(body)
        if (!validated.ok) throw new RequestError(400, 'invalid_request', validated.error)
        const task = await store.createTask(validated.value)
        sendJson(res, 201, { task })
        return
      }
      if (route === 'tasks' && method === 'PATCH') {
        const body = await readJsonBody(req)
        if (typeof body.id !== 'string' || body.id === '') {
          throw new RequestError(400, 'invalid_request', 'id is required')
        }
        const task = store.findTask(body.id)
        if (task === undefined) throw new RequestError(404, 'not_found', 'task not found')
        const running = task.status === 'running' || task.status === 'queued'
        if (running && Object.keys(body).some((key) => key !== 'id' && key !== 'title')) {
          throw new RequestError(409, 'conflict', 'only the title can be edited while the task is running')
        }
        const validated = validateTaskPatch(body)
        if (!validated.ok) throw new RequestError(400, 'invalid_request', validated.error)
        const updated = await store.updateTask(body.id, validated.value)
        sendJson(res, 200, { task: updated })
        return
      }
      if (route === 'tasks' && method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id === null || id === '') throw new RequestError(400, 'invalid_request', 'id is required')
        const task = store.findTask(id)
        if (task === undefined) throw new RequestError(404, 'not_found', 'task not found')
        if (task.status === 'running' || task.status === 'queued') {
          throw new RequestError(409, 'conflict', 'cancel the task before deleting it')
        }
        sendJson(res, 200, await store.deleteTask(id))
        return
      }
      if (route === 'run' && method === 'POST') {
        const body = await readJsonBody(req)
        let ids
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
            throw new RequestError(400, 'invalid_request', 'ids must be an array of task ids')
          }
          ids = body.ids
        }
        const started = scheduler.startManual(ids)
        if (started.error === 'conflict') throw new RequestError(409, 'conflict', 'a run is already active')
        if (started.error === 'not_found') {
          throw new RequestError(404, 'not_found', `unknown task ids: ${(started.missing ?? []).join(', ')}`)
        }
        if (started.error === 'no-tasks') throw new RequestError(400, 'no-tasks', 'no pending task to run')
        sendJson(res, 202, started)
        return
      }
      if (route === 'cancel' && method === 'POST') {
        const body = await readJsonBody(req)
        if (typeof body.taskId !== 'string' || body.taskId === '') {
          throw new RequestError(400, 'invalid_request', 'taskId is required')
        }
        const result = scheduler.cancel(body.taskId)
        if (result.error === 'not_found') throw new RequestError(404, 'not_found', 'task not found')
        if (result.error === 'not_running') throw new RequestError(409, 'conflict', 'task is not running')
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, { code: 'not_found', message: 'unknown route' })
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(res, error.status, { code: error.code, message: error.message })
        return
      }
      if (error?.code === 'not_found') {
        sendJson(res, 404, { code: 'not_found', message: String(error.message) })
        return
      }
      logger?.warn?.(`[dsh-task-plan] route ${method} ${url.pathname} failed: ${String(error?.message ?? error)}`)
      sendJson(res, 500, { code: 'internal', message: String(error?.message ?? error) })
    }
  }
}
