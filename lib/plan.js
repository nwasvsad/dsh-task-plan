/**
 * Durable task-plan state: one JSON document, atomic replacement, and one
 * serial write lock shared by HTTP mutations and the scheduler.
 *
 * @module dsh-task-plan/plan
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Task kinds accepted by the UI and the report. */
export const KINDS = ['dev', 'research', 'data', 'ops', 'writing', 'automation', 'other']

/** Task lifecycle values. */
export const STATUSES = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']

/** Maximum retained execution records. */
export const MAX_EXECUTIONS = 200

/**
 * Empty plan state.
 * @returns {object}
 */
export function defaultState() {
  return {
    version: 1,
    tasks: [],
    executions: [],
    meta: { lastAutoRunDate: null, lastSummaryDate: null },
  }
}

/**
 * Math-safe timestamp read.
 * @param {unknown} value Candidate.
 * @param {number} fallback Fallback value.
 * @returns {number}
 */
function timestampOf(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback
}

/**
 * Normalize one stored task.
 * @param {unknown} raw Raw record.
 * @param {(message: string) => void} warn Warning sink.
 * @returns {object | null}
 */
function normalizeTask(raw, warn) {
  if (raw === null || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null
  if (typeof raw.instruction !== 'string' || raw.instruction.trim() === '') return null
  const status = STATUSES.includes(raw.status) ? raw.status : 'pending'
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'other'
  const createdAt = timestampOf(raw.createdAt, Date.now())
  const task = {
    id: raw.id,
    title: raw.title.trim().slice(0, 120),
    instruction: raw.instruction.trim(),
    kind,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
    enabled: raw.enabled !== false,
    createdAt,
    updatedAt: timestampOf(raw.updatedAt, createdAt),
    status,
    lastRun: raw.lastRun !== null && typeof raw.lastRun === 'object' ? raw.lastRun : null,
  }
  if (status !== raw.status) warn(`task ${raw.id}: unknown status ${String(raw.status)}, reset to pending`)
  if (kind !== raw.kind) warn(`task ${raw.id}: unknown kind ${String(raw.kind)}, reset to other`)
  return task
}

/**
 * Normalize one stored execution record.
 * @param {unknown} raw Raw record.
 * @returns {object | null}
 */
function normalizeExecution(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.taskId !== 'string' || raw.taskId === '') return null
  return {
    ...raw,
    startedAt: timestampOf(raw.startedAt, 0),
    finishedAt: timestampOf(raw.finishedAt, 0),
    durationMs: timestampOf(raw.durationMs, 0),
    usage: raw.usage ?? {},
    cost: raw.cost ?? {},
  }
}

/**
 * Validate and normalize a parsed state document.
 * @param {unknown} raw Parsed JSON.
 * @param {(message: string) => void} [warn] Warning sink.
 * @returns {object}
 */
export function normalizeState(raw, warn = () => {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plan.json root must be an object')
  }
  if (!Array.isArray(raw.tasks)) throw new Error('plan.json tasks must be an array')
  if (!Array.isArray(raw.executions)) throw new Error('plan.json executions must be an array')

  const tasks = []
  for (const item of raw.tasks) {
    const task = normalizeTask(item, warn)
    if (task === null) {
      warn('dropped an invalid task record')
      continue
    }
    tasks.push(task)
  }
  const executions = []
  for (const item of raw.executions) {
    const execution = normalizeExecution(item)
    if (execution !== null) executions.push(execution)
  }
  const meta = raw.meta !== null && typeof raw.meta === 'object' ? raw.meta : {}
  return {
    version: 1,
    tasks,
    executions: executions.slice(-MAX_EXECUTIONS),
    meta: {
      lastAutoRunDate: typeof meta.lastAutoRunDate === 'string' ? meta.lastAutoRunDate : null,
      lastSummaryDate: typeof meta.lastSummaryDate === 'string' ? meta.lastSummaryDate : null,
    },
  }
}

/**
 * Validate one create-task request body.
 * @param {unknown} input Raw input.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateCreateTask(input) {
  if (input === null || typeof input !== 'object') return { ok: false, error: 'body must be an object' }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') return { ok: false, error: 'title is required' }
  if (title.length > 120) return { ok: false, error: 'title must be at most 120 characters' }
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
  if (instruction === '') return { ok: false, error: 'instruction is required' }
  if (instruction.length > 20000) return { ok: false, error: 'instruction must be at most 20000 characters' }
  const kind = input.kind === undefined ? 'other' : input.kind
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
  let cwd = null
  if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '') {
    if (typeof input.cwd !== 'string') return { ok: false, error: 'cwd must be a string' }
    const value = input.cwd.trim()
    if (value.length > 512) return { ok: false, error: 'cwd must be at most 512 characters' }
    if (!path.isAbsolute(value)) return { ok: false, error: 'cwd must be an absolute path' }
    cwd = value
  }
  const enabled = input.enabled === undefined ? true : input.enabled
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
  return { ok: true, value: { title, instruction, kind, cwd, enabled } }
}

/**
 * Validate one task patch. Every provided field is validated; at least one is required.
 * @param {unknown} input Raw patch.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateTaskPatch(input) {
  if (input === null || typeof input !== 'object') return { ok: false, error: 'body must be an object' }
  /** @type {object} */
  const value = {}
  let count = 0
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') return { ok: false, error: 'title must be a string' }
    const title = input.title.trim()
    if (title === '' || title.length > 120) return { ok: false, error: 'title must be 1..120 characters' }
    value.title = title
    count += 1
  }
  if (input.instruction !== undefined) {
    if (typeof input.instruction !== 'string') return { ok: false, error: 'instruction must be a string' }
    const instruction = input.instruction.trim()
    if (instruction === '' || instruction.length > 20000) {
      return { ok: false, error: 'instruction must be 1..20000 characters' }
    }
    value.instruction = instruction
    count += 1
  }
  if (input.kind !== undefined) {
    if (!KINDS.includes(input.kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
    value.kind = input.kind
    count += 1
  }
  if (input.cwd !== undefined) {
    if (input.cwd === null || input.cwd === '') {
      value.cwd = null
    } else {
      if (typeof input.cwd !== 'string') return { ok: false, error: 'cwd must be a string or null' }
      const cwd = input.cwd.trim()
      if (cwd.length > 512) return { ok: false, error: 'cwd must be at most 512 characters' }
      if (!path.isAbsolute(cwd)) return { ok: false, error: 'cwd must be an absolute path' }
      value.cwd = cwd
    }
    count += 1
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
    value.enabled = input.enabled
    count += 1
  }
  if (count === 0) return { ok: false, error: 'no editable field provided' }
  return { ok: true, value }
}

/**
 * One plan document owner.
 */
export class PlanStore {
  #state = defaultState()
  #chain = Promise.resolve()
  #file
  #dir
  #now
  #logger

  /**
   * @param {object} options Store options.
   * @param {string} options.dataDir Absolute data directory.
   * @param {object} [options.logger] Host logger.
   * @param {() => number} [options.now] Clock.
   */
  constructor({ dataDir, logger, now = Date.now }) {
    this.#dir = dataDir
    this.#file = path.join(dataDir, 'plan.json')
    this.#now = now
    this.#logger = logger
    /** @type {string[]} */
    this.warnings = []
  }

  /** Current in-memory state (read-only by convention). */
  get state() {
    return this.#state
  }

  /** Absolute state file path. */
  get file() {
    return this.#file
  }

  /** Active data directory. */
  get dataDir() {
    return this.#dir
  }

  /** @param {string} message */
  #warn(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message)
    this.#logger?.warn?.(`[dsh-task-plan] ${message}`)
    if (this.warnings.length > 20) this.warnings.shift()
  }

  /**
   * Load the state document, backing up a corrupt file instead of losing it.
   * @returns {Promise<void>}
   */
  async load() {
    await fs.mkdir(this.#dir, { recursive: true })
    let raw
    try {
      raw = await fs.readFile(this.#file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#state = defaultState()
        return
      }
      throw error
    }
    try {
      const parsed = JSON.parse(raw)
      this.#state = normalizeState(parsed, (message) => this.#warn(message))
    } catch (error) {
      const backup = `${this.#file}.corrupt-${this.#now()}`
      try {
        await fs.rename(this.#file, backup)
        this.#warn(`plan.json is unreadable (${String(error?.message ?? error)}); moved to ${backup}`)
      } catch (renameError) {
        this.#warn(`plan.json is unreadable and could not be backed up: ${String(renameError?.message ?? renameError)}`)
      }
      this.#state = defaultState()
    }
  }

  /**
   * Run one mutation under the serial lock and persist the result.
   * @template T
   * @param {(state: object) => T | Promise<T>} operation Mutation.
   * @returns {Promise<T>}
   */
  mutate(operation) {
    const next = this.#chain.then(async () => {
      const result = await operation(this.#state)
      await this.save()
      return result
    })
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Atomically replace plan.json.
   * @returns {Promise<void>}
   */
  async save() {
    const body = JSON.stringify(this.#state, null, 2)
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, body, 'utf8')
    await fs.rename(temporary, this.#file)
  }

  /**
   * Find one task by id.
   * @param {string} id Task id.
   * @returns {object | undefined}
   */
  findTask(id) {
    return this.#state.tasks.find((task) => task.id === id)
  }

  /**
   * Find one task, or throw a stable error.
   * @param {string} id Task id.
   * @returns {object}
   */
  requireTask(id) {
    const task = this.findTask(id)
    if (task === undefined) {
      const error = new Error(`task not found: ${id}`)
      error.code = 'not_found'
      throw error
    }
    return task
  }

  /**
   * Create one task.
   * @param {{title:string,instruction:string,kind:string,cwd:string|null,enabled:boolean}} input Validated input.
   * @returns {Promise<object>}
   */
  createTask(input) {
    return this.mutate((state) => {
      const now = this.#now()
      const task = {
        id: `tsk_${randomUUID()}`,
        ...input,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        lastRun: null,
      }
      state.tasks.push(task)
      return task
    })
  }

  /**
   * Apply a validated patch.
   * @param {string} id Task id.
   * @param {object} patch Validated patch.
   * @returns {Promise<object>}
   */
  updateTask(id, patch) {
    return this.mutate((state) => {
      const task = this.requireTask(id)
      Object.assign(task, patch)
      task.updatedAt = this.#now()
      return task
    })
  }

  /**
   * Remove one task. Execution history is retained.
   * @param {string} id Task id.
   * @returns {Promise<{id:string, deleted:true}>}
   */
  deleteTask(id) {
    return this.mutate((state) => {
      const index = state.tasks.findIndex((task) => task.id === id)
      if (index < 0) {
        const error = new Error(`task not found: ${id}`)
        error.code = 'not_found'
        throw error
      }
      state.tasks.splice(index, 1)
      return { id, deleted: true }
    })
  }

  /**
   * Set one task's lifecycle status.
   * @param {string} id Task id.
   * @param {string} status New status.
   * @returns {Promise<object>}
   */
  setStatus(id, status) {
    return this.mutate((state) => {
      const task = this.requireTask(id)
      task.status = status
      task.updatedAt = this.#now()
      return task
    })
  }

  /**
   * Append one execution record, bound it to its task, and prune history.
   * @param {object} execution Execution record.
   * @returns {Promise<object>}
   */
  recordExecution(execution) {
    return this.mutate((state) => {
      state.executions.push(execution)
      if (state.executions.length > MAX_EXECUTIONS) {
        state.executions.splice(0, state.executions.length - MAX_EXECUTIONS)
      }
      const task = state.tasks.find((item) => item.id === execution.taskId)
      if (task !== undefined) {
        task.lastRun = execution
        task.status = execution.status
        task.updatedAt = this.#now()
      }
      return execution
    })
  }

  /**
   * Merge metadata fields.
   * @param {object} patch Metadata patch.
   * @returns {Promise<object>}
   */
  setMeta(patch) {
    return this.mutate((state) => {
      state.meta = { ...state.meta, ...patch }
      return state.meta
    })
  }

  /**
   * Executions recorded for one Beijing date.
   * @param {string} date `YYYY-MM-DD`.
   * @returns {object[]}
   */
  executionsForDate(date) {
    return this.#state.executions.filter((execution) => execution.date === date)
  }

  /**
   * Tasks ready for an automatic run.
   * @returns {object[]}
   */
  pendingTasks() {
    return this.#state.tasks.filter((task) => task.enabled && task.status === 'pending')
  }
}
