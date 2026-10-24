/**
 * Task execution: create one Session per task, prompt it, wait for the turn to
 * settle, then fold its token usage, cost, result, and subagent usage.
 *
 * @module dsh-task-plan/runner
 */
import { randomUUID } from 'node:crypto'
import {
  addUsage,
  countToolCalls,
  emptyUsage,
  foldUsage,
  lastAssistantText,
  lastTurnEnd,
  outcomeOfTurnEnd,
  truncate,
} from './usage.js'

/** Human labels for task kinds. */
export const KIND_LABELS = {
  dev: '开发',
  research: '调研',
  data: '数据',
  ops: '运维',
  writing: '写作',
  automation: '自动化',
  other: '其他',
}

/**
 * Default sleep, injectable for tests.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the prompt one planned task sends to its agent.
 * @param {object} task Task record.
 * @returns {string}
 */
export function taskPrompt(task) {
  const kind = KIND_LABELS[task.kind] ?? task.kind ?? '其他'
  return [
    `[[dsh-task-plan]] 任务：${task.title}（类型：${kind}）`,
    '',
    '你是由「任务计划」插件自动调度的执行代理。请在工作目录内独立完成下面的任务，不要等待人工确认。',
    '完成后用简短中文总结：1) 做了什么 2) 结果/产出（如有文件，给路径） 3) 遇到的问题与后续建议。',
    '',
    '任务说明：',
    task.instruction,
  ].join('\n')
}

/**
 * Execute one session and wait for its first turn to settle.
 */
export class Runner {
  #sessionController
  #sessionQuery
  #subagents
  #config
  #logger
  #now
  #sleep
  #tokens = new Map()
  #queued = null
  #queuedCancel = new Set()
  #active = false

  /**
   * @param {object} options Runner options.
   * @param {object} options.sessionController Host Session controller.
   * @param {object} options.sessionQuery Host session query service.
   * @param {object | undefined} options.subagents Host subagent runtime.
   * @param {object} options.config Normalized plugin config.
   * @param {object} [options.logger] Host logger.
   * @param {() => number} [options.now] Clock.
   * @param {(ms:number) => Promise<void>} [options.sleep] Sleep implementation.
   */
  constructor({ sessionController, sessionQuery, subagents, config, logger, now = Date.now, sleep = defaultSleep }) {
    this.#sessionController = sessionController
    this.#sessionQuery = sessionQuery
    this.#subagents = subagents
    this.#config = config
    this.#logger = logger
    this.#now = now
    this.#sleep = sleep
  }

  /** Whether a task run is in flight. */
  isActive() {
    return this.#active
  }

  /** Number of live task slots. */
  activeCount() {
    return this.#tokens.size
  }

  /**
   * Ask one running task to stop. The waiting loop observes the token and marks
   * the execution cancelled.
   * @param {string} taskId Task id.
   * @returns {boolean} Whether the task was active.
   */
  cancel(taskId) {
    const token = this.#tokens.get(taskId)
    if (token !== undefined) {
      token.cancelled = true
      if (token.sessionId !== undefined) {
        try {
          this.#sessionController.cancel({ sessionId: token.sessionId })
        } catch (error) {
          this.#logger?.warn?.(`[dsh-task-plan] cancel ${taskId} failed: ${String(error?.message ?? error)}`)
        }
      }
      return true
    }
    if (this.#queued !== null && this.#queued.has(taskId)) {
      this.#queuedCancel.add(taskId)
      return true
    }
    return false
  }

  /**
   * Read one session log, folding inside the observation's lifetime.
   * @template T
   * @param {string} sessionId Session id.
   * @param {(events: ReadonlyArray<object>, observation: object) => T} operation Fold.
   * @returns {Promise<T>}
   */
  async withSession(sessionId, operation) {
    const observation = await this.#sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    try {
      return operation(observation.events ?? [], observation)
    } finally {
      try {
        observation[Symbol.dispose]?.()
      } catch {
        // Disposal is best-effort.
      }
      try {
        observation.dispose?.()
      } catch {
        // A duplicate dispose is harmless.
      }
    }
  }

  /**
   * Create one Session and run one turn to completion.
   * @param {object} request Run request.
   * @param {string} request.title Session title.
   * @param {string} request.prompt First user prompt.
   * @param {string} request.cwd Working directory.
   * @param {number} [request.timeoutMs] Turn timeout.
   * @param {{cancelled:boolean, sessionId?:string}} [request.token] Cancellation token.
   * @returns {Promise<object>} Execution facts.
   */
  async runSession({ title, prompt, cwd, timeoutMs = this.#config.taskTimeoutMs, token }) {
    const startedAt = this.#now()
    let sessionId = null
    const base = {
      sessionId: null,
      status: 'failed',
      turnEnd: null,
      error: null,
      result: '',
      usage: emptyUsage().usage,
      cost: emptyUsage().cost,
      models: [],
      childSessionIds: [],
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    }

    try {
      const created = await this.#sessionController.create({
        cwd,
        ...(this.#config.agentPreset ? { agentPreset: this.#config.agentPreset } : {}),
      })
      sessionId = created?.sessionId ?? null
    } catch (error) {
      return {
        ...base,
        error: { code: 'session-create-failed', message: String(error?.message ?? error) },
        finishedAt: this.#now(),
        durationMs: this.#now() - startedAt,
      }
    }
    if (sessionId === null) {
      return {
        ...base,
        error: { code: 'session-create-failed', message: 'session controller returned no session id' },
        finishedAt: this.#now(),
        durationMs: this.#now() - startedAt,
      }
    }
    base.sessionId = sessionId
    if (token !== undefined) token.sessionId = sessionId

    try {
      await this.#sessionController.rename({ sessionId, title: truncate(title, 120) })
    } catch (error) {
      this.#logger?.warn?.(`[dsh-task-plan] rename ${sessionId} failed: ${String(error?.message ?? error)}`)
    }

    try {
      await this.#sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        new AbortController().signal,
      )
    } catch (error) {
      return {
        ...base,
        error: { code: 'prompt-rejected', message: String(error?.message ?? error) },
        finishedAt: this.#now(),
        durationMs: this.#now() - startedAt,
      }
    }

    let agent = null
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const resolved = await this.#sessionController.resolveAgent(sessionId)
        if (resolved?.agent !== undefined) {
          agent = resolved.agent
          break
        }
        await this.#sleep(100)
      }
    } catch (error) {
      this.#logger?.warn?.(`[dsh-task-plan] resolveAgent ${sessionId} failed: ${String(error?.message ?? error)}`)
    }

    const wait = await this.#waitTurn({ agent, startedAt, timeoutMs, token })
    const finishedAt = this.#now()
    let cancelled = wait.state === 'cancelled'
    let timedOut = wait.state === 'timeout'

    if (cancelled || timedOut) {
      try {
        this.#sessionController.cancel({ sessionId })
      } catch (error) {
        this.#logger?.warn?.(`[dsh-task-plan] cancel ${sessionId} failed: ${String(error?.message ?? error)}`)
      }
      await this.#sleep(200)
    }

    let events = []
    try {
      events = await this.withSession(sessionId, (sessionEvents) => sessionEvents.slice())
    } catch (error) {
      return {
        ...base,
        error: { code: 'log-unreadable', message: String(error?.message ?? error) },
        finishedAt,
        durationMs: finishedAt - startedAt,
      }
    }

    const turnEnd = lastTurnEnd(events)
    const usage = foldUsage(events, { holidays: this.#config.holidays })
    const result = truncate(lastAssistantText(events), 2000)
    if (timedOut && turnEnd?.kind === 'completed') timedOut = false

    /** @type {string[]} */
    const childSessionIds = []
    let combined = usage
    try {
      const descendants = (await this.#subagents?.listDescendants?.(sessionId, undefined)) ?? []
      let budget = 20
      for (const entry of descendants) {
        if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue
        if (budget <= 0) break
        budget -= 1
        childSessionIds.push(entry.id)
        try {
          const childUsage = await this.withSession(entry.id, (childEvents) =>
            foldUsage(childEvents, { holidays: this.#config.holidays }),
          )
          combined = addUsage(combined, childUsage)
        } catch (error) {
          this.#logger?.warn?.(`[dsh-task-plan] child log ${entry.id} unreadable: ${String(error?.message ?? error)}`)
        }
      }
    } catch (error) {
      this.#logger?.warn?.(`[dsh-task-plan] listDescendants ${sessionId} failed: ${String(error?.message ?? error)}`)
    }

    if (cancelled) {
      return {
        ...base,
        status: 'cancelled',
        turnEnd: turnEnd?.kind ?? null,
        error: { code: 'cancelled', message: 'cancelled by user' },
        result,
        usage: combined.usage,
        cost: combined.cost,
        models: combined.models,
        childSessionIds,
        finishedAt,
        durationMs: finishedAt - startedAt,
      }
    }
    if (timedOut) {
      return {
        ...base,
        status: 'failed',
        turnEnd: turnEnd?.kind ?? null,
        error: { code: 'timeout', message: `turn exceeded ${timeoutMs} ms` },
        result,
        usage: combined.usage,
        cost: combined.cost,
        models: combined.models,
        childSessionIds,
        finishedAt,
        durationMs: finishedAt - startedAt,
      }
    }

    if (turnEnd === null) {
      // A very fast turn can start and settle between two status polls; the log
      // is the authority, so a missing turn/end is the only real failure here.
      return {
        ...base,
        status: 'failed',
        error: { code: 'no-turn', message: 'the agent accepted the prompt but recorded no turn' },
        result,
        usage: combined.usage,
        cost: combined.cost,
        models: combined.models,
        childSessionIds,
        finishedAt,
        durationMs: finishedAt - startedAt,
      }
    }

    const outcome = outcomeOfTurnEnd(turnEnd)
    let status = 'done'
    let error = null
    if (outcome === 'failed') {
      status = 'failed'
      error =
        turnEnd.kind === 'error'
          ? { code: 'turn-error', message: String(turnEnd.error?.message ?? turnEnd.error?.code ?? 'turn failed') }
          : { code: 'blocked', message: 'the turn was blocked' }
    } else if (outcome === 'cancelled') {
      status = 'cancelled'
      error = { code: 'aborted', message: String(turnEnd.reason ?? 'turn aborted') }
    } else if (outcome === 'interrupted') {
      status = 'interrupted'
      error = { code: 'interrupted', message: 'turn was interrupted' }
    } else if (outcome === 'unknown') {
      status = 'failed'
      error = { code: 'unknown-turn-end', message: String(turnEnd.kind ?? 'unknown') }
    }

    return {
      ...base,
      status,
      turnEnd: turnEnd.kind ?? null,
      error,
      result,
      usage: combined.usage,
      cost: combined.cost,
      models: combined.models,
      childSessionIds,
      finishedAt,
      durationMs: finishedAt - startedAt,
    }
  }

  /**
   * Poll the live agent until the first turn settles, the start grace expires,
   * or the turn deadline passes.
   * @param {object} input Wait input.
   * @param {object | null} input.agent Live agent or null.
   * @param {number} input.startedAt Run start.
   * @param {number} input.timeoutMs Turn timeout.
   * @param {{cancelled:boolean}} [input.token] Cancellation token.
   * @returns {Promise<{state:'done'|'cancelled'|'timeout'|'no-run'}>}
   */
  async #waitTurn({ agent, startedAt, timeoutMs, token }) {
    const deadline = startedAt + timeoutMs
    let sawRunning = false
    for (;;) {
      if (token?.cancelled) return { state: 'cancelled' }
      const status = agent?.status
      if (status === 'running') sawRunning = true
      else if (sawRunning) return { state: 'done' }
      if (this.#now() >= deadline) return { state: sawRunning ? 'timeout' : 'no-run' }
      if (!sawRunning && this.#now() - startedAt >= this.#config.startTimeoutMs) return { state: 'no-run' }
      await this.#sleep(this.#config.pollIntervalMs)
    }
  }

  /**
   * Run one task and produce its execution record.
   * @param {object} task Task record.
   * @param {object} options Run options.
   * @param {string} options.runId Run id.
   * @param {string} options.date Beijing date.
   * @param {{cancelled:boolean, sessionId?:string}} [options.token] Cancellation token.
   * @returns {Promise<object>}
   */
  async runOne(task, { runId, date, token }) {
    const result = await this.runSession({
      title: task.title,
      prompt: taskPrompt(task),
      cwd: task.cwd ?? this.#config.defaultCwd,
      timeoutMs: this.#config.taskTimeoutMs,
      token,
    })
    return {
      id: `exe_${randomUUID()}`,
      runId,
      date,
      taskId: task.id,
      taskTitle: task.title,
      kind: task.kind,
      ...result,
    }
  }

  /**
   * Run a batch with the configured concurrency, reporting every transition.
   * @param {object[]} tasks Tasks to run.
   * @param {object} options Run options.
   * @param {string} options.runId Run id.
   * @param {string} options.date Beijing date.
   * @param {(task:object)=>Promise<void>} [options.onQueued] Queued hook.
   * @param {(task:object)=>Promise<void>} [options.onStart] Start hook.
   * @param {(task:object, execution:object)=>Promise<void>} [options.onFinish] Finish hook.
   * @returns {Promise<object[]>}
   */
  async runAll(tasks, { runId, date, onQueued, onStart, onFinish }) {
    this.#active = true
    this.#queued = new Set(tasks.map((task) => task.id))
    this.#queuedCancel.clear()
    let index = 0
    /** @type {object[]} */
    const results = []
    const workers = Math.max(1, Math.min(this.#config.concurrency, tasks.length))
    const worker = async () => {
      for (;;) {
        const current = index
        index += 1
        if (current >= tasks.length) return
        const task = tasks[current]
        if (this.#queuedCancel.has(task.id)) {
          this.#queuedCancel.delete(task.id)
          this.#queued.delete(task.id)
          const empty = emptyUsage()
          const now = this.#now()
          const execution = {
            id: `exe_${randomUUID()}`,
            runId,
            date,
            taskId: task.id,
            taskTitle: task.title,
            kind: task.kind,
            sessionId: null,
            childSessionIds: [],
            status: 'cancelled',
            turnEnd: null,
            error: { code: 'cancelled', message: 'cancelled before the worker picked it up' },
            result: '',
            usage: empty.usage,
            cost: empty.cost,
            models: [],
            startedAt: now,
            finishedAt: now,
            durationMs: 0,
          }
          results.push(execution)
          await onFinish?.(task, execution)
          continue
        }
        this.#queued.delete(task.id)
        await onQueued?.(task)
        await onStart?.(task)
        const token = { cancelled: false, sessionId: undefined }
        this.#tokens.set(task.id, token)
        try {
          let execution
          try {
            execution = await this.runOne(task, { runId, date, token })
          } catch (error) {
            const empty = emptyUsage()
            const now = this.#now()
            execution = {
              id: `exe_${randomUUID()}`,
              runId,
              date,
              taskId: task.id,
              taskTitle: task.title,
              kind: task.kind,
              sessionId: token.sessionId ?? null,
              childSessionIds: [],
              status: 'failed',
              turnEnd: null,
              error: { code: 'internal', message: String(error?.message ?? error) },
              result: '',
              usage: empty.usage,
              cost: empty.cost,
              models: [],
              startedAt: now,
              finishedAt: now,
              durationMs: 0,
            }
          }
          results.push(execution)
          await onFinish?.(task, execution)
        } finally {
          this.#tokens.delete(task.id)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: workers }, worker))
    } finally {
      this.#active = false
      this.#queued = null
      this.#queuedCancel.clear()
    }
    return results
  }
}
