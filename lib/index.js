/**
 * DeepSeek Harness task-plan plugin, host half.
 *
 * One global page owns a durable plan table. A 30-second scheduler runs the
 * pending tasks at the configured off-peak time (one new Session per task).
 * Daily digests live in the independent dsh-task-digest package.
 *
 * @module dsh-task-plan
 */
import os from 'node:os'
import path from 'node:path'
import { normalizeHolidays, parseHHMM } from './tier.js'
import { PlanStore } from './plan.js'
import { Runner } from './runner.js'
import { Scheduler } from './scheduler.js'
import { createTaskPlanRoutes } from './routes.js'

/** Plugin id; also the browser module-table key. */
export const name = 'dsh-task-plan'

/** Required host services. */
export const inject = ['webServer', 'connection', 'sessionQuery', 'sessionController', 'subagents']

/** Default route prefix. */
export const API_PREFIX = '/api/task-plan'

/**
 * Default harness data directory.
 * @returns {string}
 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME?.trim()
  const root = home !== undefined && home !== '' ? home : path.join(os.homedir(), '.dsh')
  return path.join(root, 'task-plan')
}

/**
 * Expand a leading `~` against the OS home; absolute paths pass through.
 * @param {string} value Configured path.
 * @returns {string}
 */
function expandPath(value) {
  const text = value.trim()
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

/**
 * Normalize raw loader-row config. Malformed values fall back to defaults.
 * @param {object} [raw] Raw row config.
 * @returns {object}
 */
export function resolveConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const integer = (value, fallback, min, max) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
  const time = (value, fallback) => (parseHHMM(value) !== null ? value : fallback)
  const absolutePath = (value, fallback) => {
    if (typeof value !== 'string' || value.trim() === '') return fallback
    const expanded = expandPath(value)
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  }

  const dataDir = absolutePath(source.dataDir, defaultDataDir())
  return {
    enabled: bool(source.enabled, true),
    dataDir,
    defaultCwd: absolutePath(source.defaultCwd, process.cwd()),
    agentPreset:
      typeof source.agentPreset === 'string' && source.agentPreset.trim() !== ''
        ? source.agentPreset.trim()
        : null,
    runAt: time(source.runAt, '18:00'),
    offPeakOnly: bool(source.offPeakOnly, true),
    autoRunEnabled: bool(source.autoRunEnabled, true),
    holidays: normalizeHolidays(source.holidays),
    concurrency: integer(source.concurrency, 2, 1, 8),
    maxTasksPerRun: integer(source.maxTasksPerRun, 20, 1, 100),
    taskTimeoutMs: integer(source.taskTimeoutMs, 30 * 60 * 1000, 60 * 1000, 12 * 60 * 60 * 1000),
    startTimeoutMs: integer(source.startTimeoutMs, 15 * 1000, 1000, 5 * 60 * 1000),
    pollIntervalMs: integer(source.pollIntervalMs, 500, 100, 5000),
    currency:
      typeof source.currency === 'string' && source.currency !== '' ? source.currency.slice(0, 4) : '¥',
  }
}

/**
 * Plugin body.
 * @param {object} ctx Host context.
 * @param {object} [raw] Raw row config.
 * @returns {Promise<void>}
 */
export async function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : undefined
  const warn = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }
  const info = (message) => {
    if (typeof logger?.info === 'function') logger.info(message)
    else console.log(message)
  }

  const store = new PlanStore({ dataDir: config.dataDir, logger })
  try {
    await store.load()
  } catch (error) {
    warn(`[${name}] plan.json load failed (continuing with an empty plan): ${String(error?.message ?? error)}`)
  }

  const runner = new Runner({
    sessionController: ctx.sessionController,
    sessionQuery: ctx.sessionQuery,
    subagents: ctx.subagents,
    config,
    logger,
  })
  const scheduler = new Scheduler({ store, runner, config, logger })
  try {
    await scheduler.recover()
  } catch (error) {
    warn(`[${name}] interrupted-task recovery failed: ${String(error?.message ?? error)}`)
  }

  const handler = createTaskPlanRoutes({ ctx, store, scheduler, config, logger })
  const register = () =>
    ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  if (typeof ctx.effect === 'function') ctx.effect(register, `${name}: ${API_PREFIX}`)
  else register()

  const tick = () => {
    scheduler.tick().catch((error) => {
      warn(`[${name}] scheduler tick failed: ${String(error?.message ?? error)}`)
    })
  }
  // Raw Node timers keep the host half independent of the timer service, whose
  // context gate (`timer`) differs between dsh releases. The effect below owns
  // their teardown.
  const intervalHandle = setInterval(tick, 30_000)
  const startupHandle = setTimeout(tick, 3_000)
  intervalHandle.unref?.()
  startupHandle.unref?.()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      clearInterval(intervalHandle)
      clearTimeout(startupHandle)
      scheduler.dispose()
    }, `${name}: lifecycle`)
  }

  info(
    `[${name}] plan=${path.join(config.dataDir, 'plan.json')} runAt=${config.runAt} ` +
      `offPeakOnly=${config.offPeakOnly} concurrency=${config.concurrency} auto=${config.autoRunEnabled}`,
  )
}
