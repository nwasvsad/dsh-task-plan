/**
 * Session-event folding for token usage, cost, results, and tool counts.
 *
 * The accounting rule matches `dsh-token-cost`: `assistant/message` is the
 * authoritative per-step usage record; `assistant/attempt` only fills a step
 * that produced no message, so a retried step never counts twice. Each sample
 * is priced at its own event time, which is the moment the provider billed.
 *
 * @module dsh-task-plan/usage
 */
import { priceUsage, tierAt } from './tier.js'

/**
 * Text blocks of one content array, joined with newlines.
 * @param {unknown} content Content blocks.
 * @returns {string}
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text !== '') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Whether one event timestamp falls in the optional window.
 * @param {unknown} time Event time.
 * @param {number} from Inclusive start.
 * @param {number} to Exclusive end.
 * @returns {boolean}
 */
function inWindow(time, from, to) {
  const value = Number.isFinite(time) ? Number(time) : 0
  return value >= from && value < to
}

/**
 * Fold one session's usage samples into tokens, cost, and models.
 * @param {ReadonlyArray<object>} events Durable events in seq order.
 * @param {object} [options] Fold options.
 * @param {number} [options.from] Inclusive event-time start.
 * @param {number} [options.to] Exclusive event-time end.
 * @param {readonly string[]} [options.holidays] Beijing holidays.
 * @param {object} [options.table] Price table override (tests).
 * @returns {{usage:{inputTokens:number,cacheReadTokens:number,cacheWriteTokens:number,outputTokens:number,totalTokens:number}, cost:{cny:number,peakCny:number,offPeakCny:number,unknownModels:string[]}, models:string[], samples:number}}
 */
export function foldUsage(events, options = {}) {
  const from = Number.isFinite(options.from) ? options.from : Number.NEGATIVE_INFINITY
  const to = Number.isFinite(options.to) ? options.to : Number.POSITIVE_INFINITY
  const holidays = options.holidays ?? []
  /** @type {Map<string, {time:number, fromMessage:boolean, usage:object, model:string|undefined}>} */
  const byStep = new Map()

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const time = Number.isFinite(event.time) ? event.time : 0
    if (!inWindow(time, from, to)) continue
    const usage = event.data?.usage
    if (usage === null || usage === undefined) continue
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) continue
    const key = `${event.data?.turn}\u0000${event.data?.step}`
    const isMessage = event.type === 'assistant/message'
    const previous = byStep.get(key)
    if (previous !== undefined) {
      if (previous.fromMessage) continue
      if (!isMessage) continue
    }
    byStep.set(key, {
      time,
      fromMessage: isMessage,
      usage,
      model: event.data?.message?.source?.model,
    })
  }

  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let cny = 0
  let peakCny = 0
  let offPeakCny = 0
  let samples = 0
  const models = new Set()
  const unknownModels = new Set()

  for (const sample of byStep.values()) {
    const usage = sample.usage
    inputTokens += Number(usage.inputTokens ?? 0)
    cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
    cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
    outputTokens += Number(usage.outputTokens ?? 0)
    samples += 1
    if (typeof sample.model === 'string' && sample.model !== '') models.add(sample.model)
    const priced = priceUsage(usage, sample.model, sample.time, { holidays, table: options.table })
    if (priced === null) {
      if (typeof sample.model === 'string' && sample.model !== '') unknownModels.add(sample.model)
      continue
    }
    cny += priced.cost
    if (priced.tier === 'peak') peakCny += priced.cost
    else offPeakCny += priced.cost
  }

  return {
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    },
    cost: {
      cny,
      peakCny,
      offPeakCny,
      unknownModels: [...unknownModels],
    },
    models: [...models],
    samples,
  }
}

/**
 * Sum two folded usage values.
 * @param {ReturnType<typeof foldUsage>} left
 * @param {ReturnType<typeof foldUsage>} right
 * @returns {ReturnType<typeof foldUsage>}
 */
export function addUsage(left, right) {
  const models = new Set([...(left.models ?? []), ...(right.models ?? [])])
  const unknown = new Set([...(left.cost?.unknownModels ?? []), ...(right.cost?.unknownModels ?? [])])
  return {
    usage: {
      inputTokens: (left.usage?.inputTokens ?? 0) + (right.usage?.inputTokens ?? 0),
      cacheReadTokens: (left.usage?.cacheReadTokens ?? 0) + (right.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: (left.usage?.cacheWriteTokens ?? 0) + (right.usage?.cacheWriteTokens ?? 0),
      outputTokens: (left.usage?.outputTokens ?? 0) + (right.usage?.outputTokens ?? 0),
      totalTokens: (left.usage?.totalTokens ?? 0) + (right.usage?.totalTokens ?? 0),
    },
    cost: {
      cny: (left.cost?.cny ?? 0) + (right.cost?.cny ?? 0),
      peakCny: (left.cost?.peakCny ?? 0) + (right.cost?.peakCny ?? 0),
      offPeakCny: (left.cost?.offPeakCny ?? 0) + (right.cost?.offPeakCny ?? 0),
      unknownModels: [...unknown],
    },
    models: [...models],
    samples: (left.samples ?? 0) + (right.samples ?? 0),
  }
}

/**
 * Empty folded usage value.
 * @returns {ReturnType<typeof foldUsage>}
 */
export function emptyUsage() {
  return {
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { cny: 0, peakCny: 0, offPeakCny: 0, unknownModels: [] },
    models: [],
    samples: 0,
  }
}

/**
 * Truncate a string without splitting a surrogate pair.
 * @param {string} value Source text.
 * @param {number} limit Maximum code units.
 * @returns {string}
 */
export function truncate(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * The last non-empty assistant text in an optional window.
 * @param {ReadonlyArray<object>} events Durable events.
 * @param {{from?:number, to?:number}} [window] Event-time window.
 * @returns {string}
 */
export function lastAssistantText(events, window = {}) {
  const from = Number.isFinite(window.from) ? window.from : Number.NEGATIVE_INFINITY
  const to = Number.isFinite(window.to) ? window.to : Number.POSITIVE_INFINITY
  let result = ''
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    if (!inWindow(event.time, from, to)) continue
    const text = textOfContent(event.data?.message?.content)
    if (text !== '') result = text
  }
  return result
}

/**
 * The last `turn/end` reason in an optional window.
 * @param {ReadonlyArray<object>} events Durable events.
 * @param {{from?:number, to?:number}} [window] Event-time window.
 * @returns {object | null}
 */
export function lastTurnEnd(events, window = {}) {
  const from = Number.isFinite(window.from) ? window.from : Number.NEGATIVE_INFINITY
  const to = Number.isFinite(window.to) ? window.to : Number.POSITIVE_INFINITY
  let result = null
  for (const event of events) {
    if (event?.type !== 'turn/end') continue
    if (!inWindow(event.time, from, to)) continue
    result = event.data?.reason ?? null
  }
  return result
}

/**
 * First human prompt text of a session, for titles and type hints.
 * @param {ReadonlyArray<object>} events Durable events.
 * @returns {string}
 */
export function firstUserText(events) {
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source !== null && typeof source === 'object' && source.kind !== 'user') continue
    const text = textOfContent(event.data?.content)
    if (text !== '') return text
  }
  return ''
}

/**
 * First line of a title, stripped of the plugin's prompt marker.
 * @param {string} text Prompt or title text.
 * @param {number} [maxChars] Maximum output length.
 * @returns {string}
 */
export function titleLine(text, maxChars = 60) {
  const cleaned = String(text ?? '')
    .replace(/^\s*\[\[dsh-task-plan(?:-summary)?\]\]\s*/, '')
    .trim()
  const line = cleaned.split('\n').find((item) => item.trim() !== '') ?? ''
  const value = line.replace(/^#+\s*/, '').trim()
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

/**
 * Count tool calls by name in an optional window.
 * @param {ReadonlyArray<object>} events Durable events.
 * @param {{from?:number, to?:number}} [window] Event-time window.
 * @returns {Record<string, number>}
 */
export function countToolCalls(events, window = {}) {
  const from = Number.isFinite(window.from) ? window.from : Number.NEGATIVE_INFINITY
  const to = Number.isFinite(window.to) ? window.to : Number.POSITIVE_INFINITY
  /** @type {Record<string, number>} */
  const counts = {}
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    if (!inWindow(event.time, from, to)) continue
    const name = typeof event.data?.name === 'string' && event.data.name !== '' ? event.data.name : 'unknown'
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

/**
 * Map one turn-end reason to a coarse task outcome.
 * @param {object | null} reason Turn-end reason.
 * @returns {'completed'|'failed'|'cancelled'|'interrupted'|'unknown'}
 */
export function outcomeOfTurnEnd(reason) {
  const kind = reason?.kind
  if (kind === 'completed' || kind === 'max-tokens') return 'completed'
  if (kind === 'aborted') return 'cancelled'
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'error' || kind === 'blocked') return 'failed'
  return 'unknown'
}

/**
 * Score a task's likely type from its title, prompt, and tool usage.
 * @param {string} title Title or prompt text.
 * @param {Record<string, number>} tools Tool-name counts.
 * @returns {'dev'|'research'|'data'|'ops'|'writing'|'automation'|'other'}
 */
export function inferKind(title, tools) {
  const text = String(title ?? '')
  const rules = [
    ['research', /调研|研究|搜索|资料|对比|分析报告|research/i],
    ['data', /数据|统计|报表|指标|抓取|爬取|清洗|dataset|sql/i],
    ['ops', /部署|运维|服务器|脚本|监控|重启|日志|docker|nginx|ssh/i],
    ['writing', /文档|写作|总结|润色|文案|报告|ppt|slide|readme/i],
    ['automation', /自动|批量|定时|流程|workflow|pipeline/i],
    ['dev', /修复|实现|开发|重构|bug|测试|接口|插件|代码|fix|implement|refactor/i],
  ]
  const textKinds = new Set()
  for (const [kind, pattern] of rules) {
    if (pattern.test(text)) textKinds.add(kind)
  }
  if (textKinds.size === 1) return [...textKinds][0]
  if (textKinds.size > 1) {
    for (const [kind] of rules) if (textKinds.has(kind)) return kind
  }

  const weights = { dev: 0, research: 0, data: 0, ops: 0, writing: 0, automation: 0 }
  for (const [name, count] of Object.entries(tools ?? {})) {
    if (/write|edit|str_replace|fs_|patch/i.test(name)) weights.dev += count * 2
    else if (/web_search|web_fetch|search/i.test(name)) weights.research += count * 2
    else if (/pwsh|bash|shell|terminal|execute-command/i.test(name)) weights.ops += count * 2
    else if (/present|office|pdf|document/i.test(name)) weights.writing += count * 2
    else if (/subagent|workflow|agent/i.test(name)) weights.automation += count * 2
    else if (/sql|data|query/i.test(name)) weights.data += count * 2
  }
  let best = 'other'
  let bestWeight = 1
  for (const [kind, weight] of Object.entries(weights)) {
    if (weight > bestWeight) {
      best = kind
      bestWeight = weight
    }
  }
  return best
}

/**
 * Whether a session log shows any model activity inside one window.
 * @param {ReadonlyArray<object>} events Durable events.
 * @param {number} from Inclusive start.
 * @param {number} to Exclusive end.
 * @returns {boolean}
 */
export function hasActivityInWindow(events, from, to) {
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    if (inWindow(event.time, from, to)) return true
  }
  return false
}

/**
 * Tier of one event instant (exported for report coverage text).
 * @param {number} timestamp Epoch ms.
 * @param {readonly string[]} holidays Holidays.
 * @returns {'peak'|'offPeak'}
 */
export function tierOf(timestamp, holidays) {
  return tierAt(timestamp, holidays)
}
