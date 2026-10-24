/**
 * Beijing-time peak/off-peak arithmetic and DeepSeek unit pricing.
 *
 * This mirrors the rule the user's `dsh-token-cost` plugin already displays, so
 * scheduling and cost agree: peak is Beijing Monday-Friday (excluding the
 * configured public holidays) 09:00-12:00 and 14:00-18:00; everything else is
 * off-peak and priced exactly half.
 *
 * Prices are CNY per 1,000,000 tokens, from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * @module dsh-task-plan/tier
 */

/** Peak windows in Beijing time, as [startHour, endHour) pairs. */
export const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
]

/** Fixed Beijing offset from UTC in milliseconds (UTC+8, no DST). */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Milliseconds in one day. */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Published price table per model per tier.
 * @type {Record<string, {peak: {cacheHit:number, cacheMiss:number, output:number}, offPeak: {cacheHit:number, cacheMiss:number, output:number}}>}
 */
export const RATE_TABLE = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
}

/** Accepted model spellings, in match order, mapped to a RATE_TABLE key. */
const MODEL_ALIASES = [
  ['deepseek-v4-pro', 'deepseek-v4-pro'],
  ['deepseek-pro', 'deepseek-v4-pro'],
  ['deepseek-flash', 'deepseek-flash'],
  ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
  ['deepseek-v4-flash', 'deepseek-flash'],
  ['deepseek-chat', 'deepseek-flash'],
  ['deepseek-reasoner', 'deepseek-flash'],
]

/**
 * Beijing calendar parts of one instant.
 * @param {number} timestamp Epoch milliseconds.
 * @returns {{year:number, month:number, day:number, weekday:number, hour:number, minute:number, second:number, date:string}}
 */
export function beijingParts(timestamp) {
  const shifted = new Date(timestamp + BEIJING_OFFSET_MS)
  const pad = (value) => String(value).padStart(2, '0')
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  return {
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    date: `${year}-${pad(month)}-${pad(day)}`,
  }
}

/**
 * Beijing `YYYY-MM-DD` of one instant.
 * @param {number} timestamp Epoch milliseconds.
 * @returns {string}
 */
export function beijingDate(timestamp) {
  return beijingParts(timestamp).date
}

/**
 * Parse one `YYYY-MM-DD` string and prove it names a real calendar day.
 * @param {string} value Date text.
 * @returns {{year:number, month:number, day:number} | null}
 */
export function dateParts(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/**
 * Whether a string names a real `YYYY-MM-DD` calendar day.
 * @param {unknown} value Candidate.
 * @returns {boolean}
 */
export function isDateString(value) {
  return dateParts(value) !== null
}

/**
 * Shift one `YYYY-MM-DD` by whole days.
 * @param {string} date Date text.
 * @param {number} days Day delta.
 * @returns {string}
 */
export function addDays(date, days) {
  const parts = dateParts(date)
  if (parts === null) throw new Error(`invalid date: ${String(date)}`)
  const base = Date.UTC(parts.year, parts.month - 1, parts.day)
  return beijingDate(base + days * DAY_MS)
}

/**
 * Previous `YYYY-MM-DD`.
 * @param {string} date Date text.
 * @returns {string}
 */
export function previousDate(date) {
  return addDays(date, -1)
}

/**
 * Parse `HH:mm` (24-hour clock).
 * @param {unknown} value Candidate.
 * @returns {{hour:number, minute:number} | null}
 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/**
 * Epoch milliseconds of one Beijing wall-clock time on one date.
 * @param {string} date `YYYY-MM-DD`.
 * @param {string} hhmm `HH:mm`.
 * @returns {number}
 */
export function timeOnDate(date, hhmm) {
  const parts = dateParts(date)
  const time = parseHHMM(hhmm)
  if (parts === null || time === null) throw new Error(`invalid date/time: ${date} ${hhmm}`)
  return Date.UTC(parts.year, parts.month - 1, parts.day, time.hour, time.minute) - BEIJING_OFFSET_MS
}

/**
 * Normalize a configured holiday list.
 * @param {unknown} value Raw config value.
 * @returns {string[]}
 */
export function normalizeHolidays(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (isDateString(item)) seen.add(item)
  }
  return [...seen].sort()
}

/**
 * Classify one instant against the official DeepSeek peak rule.
 * @param {number} timestamp Epoch milliseconds of the request.
 * @param {readonly string[]} [holidays] Beijing `YYYY-MM-DD` holidays.
 * @returns {'peak' | 'offPeak'}
 */
export function tierAt(timestamp, holidays = []) {
  const parts = beijingParts(timestamp)
  if (parts.weekday === 0 || parts.weekday === 6) return 'offPeak'
  if (holidays.includes(parts.date)) return 'offPeak'
  const peak = PEAK_WINDOWS.some(([start, end]) => parts.hour >= start && parts.hour < end)
  return peak ? 'peak' : 'offPeak'
}

/**
 * First off-peak instant at or after one instant.
 * @param {number} timestamp Epoch milliseconds.
 * @param {readonly string[]} [holidays] Beijing holidays.
 * @returns {number}
 */
export function nextOffPeak(timestamp, holidays = []) {
  if (tierAt(timestamp, holidays) === 'offPeak') return timestamp
  const parts = beijingParts(timestamp)
  const date = parts.date
  for (const hhmm of ['12:00', '18:00']) {
    const candidate = timeOnDate(date, hhmm)
    if (candidate > timestamp) return candidate
  }
  return timeOnDate(addDays(date, 1), '00:00')
}

/**
 * The wall-clock instant a daily run effectively starts: the configured time,
 * shifted forward when it lands in a peak window and offPeakOnly is set.
 * @param {string} date `YYYY-MM-DD`.
 * @param {string} runAt `HH:mm`.
 * @param {boolean} offPeakOnly Whether to defer peak times.
 * @param {readonly string[]} holidays Beijing holidays.
 * @returns {number}
 */
export function effectiveRunAt(date, runAt, offPeakOnly, holidays = []) {
  const target = timeOnDate(date, runAt)
  if (offPeakOnly && tierAt(target, holidays) === 'peak') return nextOffPeak(target, holidays)
  return target
}

/**
 * Resolve the price card of one model.
 * @param {string | undefined | null} model Model id as reported by the route.
 * @param {Record<string, {peak: object, offPeak: object}>} [table] Table override.
 * @returns {{key: string, peak: object, offPeak: object} | undefined}
 */
export function matchRateCard(model, table = RATE_TABLE) {
  if (typeof model !== 'string') return undefined
  const normalized = model.trim().toLowerCase()
  if (normalized === '') return undefined
  for (const [alias, key] of MODEL_ALIASES) {
    if (normalized === alias || normalized.startsWith(`${alias}-`)) {
      const entry = table[key]
      if (entry !== undefined) return { key, peak: entry.peak, offPeak: entry.offPeak }
    }
  }
  return undefined
}

/**
 * Cost of one usage sample under one rate card (CNY).
 * @param {{cacheHit:number, cacheMiss:number, output:number}} card Rate card.
 * @param {{inputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number, outputTokens?:number}} usage Usage buckets.
 * @returns {number}
 */
export function costOf(card, usage) {
  const hit = Number(usage?.cacheReadTokens ?? 0)
  const miss = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0)
  const output = Number(usage?.outputTokens ?? 0)
  return (hit * card.cacheHit + miss * card.cacheMiss + output * card.output) / 1_000_000
}

/**
 * Price one usage sample at one instant.
 * @param {object} usage Usage buckets.
 * @param {string | undefined | null} model Model id.
 * @param {number} timestamp Request instant.
 * @param {{holidays?: readonly string[], table?: object}} [context] Holiday and table overrides.
 * @returns {{cost:number, tier:'peak'|'offPeak', model:string} | null}
 */
export function priceUsage(usage, model, timestamp, context = {}) {
  const matched = matchRateCard(model, context.table ?? RATE_TABLE)
  if (matched === undefined) return null
  const holidays = context.holidays ?? []
  const tier = tierAt(timestamp, holidays)
  return {
    cost: costOf(matched[tier], usage),
    tier,
    model: matched.key,
  }
}

/**
 * Next automatic run instant shown to the UI.
 * @param {object} input Facts for the projection.
 * @param {number} input.now Current epoch ms.
 * @param {string} input.runAt Configured `HH:mm`.
 * @param {boolean} input.offPeakOnly Whether peak times defer.
 * @param {readonly string[]} input.holidays Beijing holidays.
 * @param {string | null} input.lastAutoRunDate Last automatic run date.
 * @param {boolean} input.hasPending Whether pending tasks exist.
 * @returns {number}
 */
export function nextScheduledRun({ now, runAt, offPeakOnly, holidays, lastAutoRunDate, hasPending }) {
  const today = beijingDate(now)
  const todayRun = effectiveRunAt(today, runAt, offPeakOnly, holidays)
  const tomorrowRun = effectiveRunAt(addDays(today, 1), runAt, offPeakOnly, holidays)

  if (!hasPending) return now < todayRun ? todayRun : tomorrowRun
  if (lastAutoRunDate === today) return tomorrowRun
  if (now >= todayRun) {
    if (offPeakOnly && tierAt(now, holidays) === 'peak') return nextOffPeak(now, holidays)
    return todayRun
  }
  return todayRun
}

/**
 * Next daily summary instant shown to the UI.
 * @param {number} now Current epoch ms.
 * @param {string} summaryAt Configured `HH:mm`.
 * @returns {number}
 */
export function nextSummaryRun(now, summaryAt) {
  const today = beijingDate(now)
  const todayAt = timeOnDate(today, summaryAt)
  return now < todayAt ? todayAt : timeOnDate(addDays(today, 1), summaryAt)
}

/**
 * Compact token count.
 * @param {number} value Token count.
 * @returns {string}
 */
export function formatTokens(value) {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}M`
}

/**
 * Money text with four decimals.
 * @param {number} value CNY.
 * @param {string} [currency] Symbol.
 * @returns {string}
 */
export function formatMoney(value, currency = '¥') {
  return `${currency}${(Number.isFinite(value) ? value : 0).toFixed(4)}`
}
