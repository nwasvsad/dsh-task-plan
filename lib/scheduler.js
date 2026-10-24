/**
 * Task-plan scheduling: one automatic run per day at the effective off-peak
 * time. Digest scheduling lives in the independent dsh-task-digest package.
 *
 * @module dsh-task-plan/scheduler
 */
import { randomUUID } from 'node:crypto'
import { beijingDate, effectiveRunAt, tierAt } from './tier.js'
import { emptyUsage } from './usage.js'

/**
 * Scheduler owning the run lock and the once-per-day due check.
 */
export class Scheduler {
  #store
  #runner
  #config
  #logger
  #now
  #disposed = false
  #ticking = false

  /** @type {object | null} */
  activeRun = null

  /**
   * @param {object} options Scheduler options.
   * @param {object} options.store Plan store.
   * @param {object} options.runner Task runner.
   * @param {object} options.config Normalized config.
   * @param {object} [options.logger] Host logger.
   * @param {() => number} [options.now] Clock.
   */
  constructor({ store, runner, config, logger, now = Date.now }) {
    this.#store = store
    this.#runner = runner
    this.#config = config
    this.#logger = logger
    this.#now = now
  }

  /**
   * Mark queued/running tasks left by a stopped Host as interrupted and record
   * one synthetic execution for each.
   * @returns {Promise<number>} Recovered task count.
   */
  async recover() {
    const broken = this.#store.state.tasks.filter(
      (task) => task.status === 'running' || task.status === 'queued',
    )
    if (broken.length === 0) return 0
    await this.#store.mutate((state) => {
      const now = this.#now()
      for (const task of broken) {
        task.status = 'interrupted'
        task.updatedAt = now
        const recoveredAt = Number.isFinite(task.updatedAt) ? task.updatedAt : now
        const empty = emptyUsage()
        const execution = {
          id: `exe_${randomUUID()}`,
          runId: `recovered_${beijingDate(now)}`,
          date: beijingDate(recoveredAt),
          taskId: task.id,
          taskTitle: task.title,
          kind: task.kind,
          sessionId: task.lastRun?.sessionId ?? null,
          childSessionIds: [],
          startedAt: recoveredAt,
          finishedAt: now,
          durationMs: Math.max(0, now - recoveredAt),
          status: 'interrupted',
          turnEnd: null,
          error: { code: 'host-restart', message: 'Host stopped while the task was queued or running' },
          result: '',
          usage: empty.usage,
          cost: empty.cost,
          models: [],
        }
        state.executions.push(execution)
        task.lastRun = execution
      }
      if (state.executions.length > 200) {
        state.executions.splice(0, state.executions.length - 200)
      }
    })
    this.#logger?.warn?.(`[dsh-task-plan] recovered ${broken.length} interrupted task(s)`)
    return broken.length
  }

  /**
   * One scheduler pass: the automatic run due check.
   * @returns {Promise<void>}
   */
  async tick() {
    if (this.#disposed || this.#ticking) return
    this.#ticking = true
    try {
      await this.#maybeAutoRun()
    } catch (error) {
      this.#logger?.warn?.(`[dsh-task-plan] scheduler tick failed: ${String(error?.message ?? error)}`)
    } finally {
      this.#ticking = false
    }
  }

  /**
   * Manual run of selected ids or every pending task.
   * @param {string[] | undefined} ids Explicit task ids.
   * @returns {{runId:string,date:string,taskIds:string[]} | {error:string,missing?:string[]}}
   */
  startManual(ids) {
    if (this.activeRun !== null) return { error: 'conflict' }
    let tasks
    if (Array.isArray(ids) && ids.length > 0) {
      const unique = [...new Set(ids)]
      const missing = unique.filter((id) => this.#store.findTask(id) === undefined)
      if (missing.length > 0) return { error: 'not_found', missing }
      tasks = unique.map((id) => this.#store.findTask(id))
    } else {
      tasks = this.#store.pendingTasks()
    }
    if (tasks.some((task) => task.status === 'running' || task.status === 'queued')) {
      return { error: 'conflict' }
    }
    if (tasks.length === 0) return { error: 'no-tasks' }
    tasks = tasks.slice(0, this.#config.maxTasksPerRun)
    return this.beginRun(tasks, { auto: false })
  }

  /**
   * Start one run and return immediately; execution continues in the background.
   * @param {object[]} tasks Tasks to run.
   * @param {{auto:boolean, date?:string}} options Run options.
   * @returns {{runId:string,date:string,taskIds:string[]} | {error:string}}
   */
  beginRun(tasks, { auto, date }) {
    if (this.activeRun !== null) return { error: 'conflict' }
    if (!Array.isArray(tasks) || tasks.length === 0) return { error: 'no-tasks' }
    const runDate = date ?? beijingDate(this.#now())
    const runId = `run_${runDate}_${randomUUID().slice(0, 8)}`
    const frozen = tasks.map((task) => ({ ...task }))
    this.activeRun = {
      runId,
      date: runDate,
      startedAt: this.#now(),
      total: frozen.length,
      done: 0,
      auto,
    }
    this.#executeRun(frozen, runId, runDate).catch((error) => {
      this.#logger?.warn?.(`[dsh-task-plan] run ${runId} failed: ${String(error?.message ?? error)}`)
    })
    return { runId, date: runDate, taskIds: frozen.map((task) => task.id) }
  }

  /**
   * Execute one frozen batch, updating task status and execution history.
   * @param {object[]} tasks Frozen task records.
   * @param {string} runId Run id.
   * @param {string} date Beijing date.
   * @returns {Promise<void>}
   */
  async #executeRun(tasks, runId, date) {
    try {
      await this.#store.mutate(() => {
        for (const task of tasks) {
          const live = this.#store.findTask(task.id)
          if (live !== undefined) {
            live.status = 'queued'
            live.updatedAt = this.#now()
          }
        }
      })
      await this.#runner.runAll(tasks, {
        runId,
        date,
        onQueued: async () => {},
        onStart: async (task) => {
          try {
            await this.#store.mutate(() => {
              const live = this.#store.findTask(task.id)
              if (live !== undefined) {
                live.status = 'running'
                live.updatedAt = this.#now()
              }
            })
          } catch (error) {
            this.#logger?.warn?.(`[dsh-task-plan] mark ${task.id} running failed: ${String(error?.message ?? error)}`)
          }
        },
        onFinish: async (task, execution) => {
          try {
            await this.#store.recordExecution(execution)
          } catch (error) {
            this.#logger?.warn?.(`[dsh-task-plan] record ${task.id} failed: ${String(error?.message ?? error)}`)
          }
          if (this.activeRun !== null && this.activeRun.runId === runId) {
            this.activeRun.done += 1
          }
        },
      })
    } finally {
      if (this.activeRun !== null && this.activeRun.runId === runId) this.activeRun = null
    }
  }

  /**
   * Cancel one running task.
   * @param {string} taskId Task id.
   * @returns {{cancelled:true} | {error:string}}
   */
  cancel(taskId) {
    if (this.#store.findTask(taskId) === undefined) return { error: 'not_found' }
    if (!this.#runner.cancel(taskId)) return { error: 'not_running' }
    return { cancelled: true }
  }

  /**
   * Automatic run due check.
   * @returns {Promise<void>}
   */
  async #maybeAutoRun() {
    if (!this.#config.enabled || !this.#config.autoRunEnabled) return
    if (this.activeRun !== null) return
    const now = this.#now()
    const today = beijingDate(now)
    if (this.#store.state.meta.lastAutoRunDate === today) return
    const pending = this.#store.pendingTasks()
    if (pending.length === 0) return
    const dueAt = effectiveRunAt(today, this.#config.runAt, this.#config.offPeakOnly, this.#config.holidays)
    if (now < dueAt) return
    if (this.#config.offPeakOnly && tierAt(now, this.#config.holidays) === 'peak') return
    const started = this.beginRun(pending.slice(0, this.#config.maxTasksPerRun), { auto: true, date: today })
    if (started.error !== undefined) {
      this.#logger?.warn?.(`[dsh-task-plan] automatic run not started: ${started.error}`)
      return
    }
    try {
      await this.#store.setMeta({ lastAutoRunDate: today })
    } catch (error) {
      this.#logger?.warn?.(`[dsh-task-plan] could not record lastAutoRunDate: ${String(error?.message ?? error)}`)
    }
    this.#logger?.info?.(`[dsh-task-plan] automatic run ${started.runId}: ${started.taskIds.length} task(s)`)
  }

  /** Stop scheduling new work (the interval is owned by the plugin entry). */
  dispose() {
    this.#disposed = true
  }
}
