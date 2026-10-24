import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addDays,
  effectiveRunAt,
  formatMoney,
  formatTokens,
  isDateString,
  nextOffPeak,
  nextScheduledRun,
  parseHHMM,
  previousDate,
  priceUsage,
  tierAt,
  timeOnDate,
} from '../lib/tier.js'
import {
  addUsage,
  countToolCalls,
  emptyUsage,
  firstUserText,
  foldUsage,
  inferKind,
  lastAssistantText,
  lastTurnEnd,
  outcomeOfTurnEnd,
  titleLine,
} from '../lib/usage.js'

const THURSDAY = '2026-10-22'
const SATURDAY = '2026-10-24'

test('tierAt follows the Beijing weekday peak windows', () => {
  assert.equal(tierAt(timeOnDate(THURSDAY, '08:59')), 'offPeak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '09:00')), 'peak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '11:59')), 'peak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '12:00')), 'offPeak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '13:59')), 'offPeak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '14:00')), 'peak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '17:59')), 'peak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '18:00')), 'offPeak')
  assert.equal(tierAt(timeOnDate(SATURDAY, '10:00')), 'offPeak')
  assert.equal(tierAt(timeOnDate(THURSDAY, '10:00'), [THURSDAY]), 'offPeak')
})

test('nextOffPeak and effectiveRunAt shift peak times forward', () => {
  assert.equal(nextOffPeak(timeOnDate(THURSDAY, '10:00')), timeOnDate(THURSDAY, '12:00'))
  assert.equal(nextOffPeak(timeOnDate(THURSDAY, '15:00')), timeOnDate(THURSDAY, '18:00'))
  assert.equal(nextOffPeak(timeOnDate(THURSDAY, '12:30')), timeOnDate(THURSDAY, '12:30'))
  assert.equal(
    effectiveRunAt(THURSDAY, '10:00', true, []),
    timeOnDate(THURSDAY, '12:00'),
  )
  assert.equal(effectiveRunAt(THURSDAY, '10:00', false, []), timeOnDate(THURSDAY, '10:00'))
  assert.equal(effectiveRunAt(SATURDAY, '10:00', true, []), timeOnDate(SATURDAY, '10:00'))
})

test('nextScheduledRun reports the next due or future instant', () => {
  const before = timeOnDate(THURSDAY, '17:00')
  assert.equal(
    nextScheduledRun({
      now: before,
      runAt: '18:00',
      offPeakOnly: true,
      holidays: [],
      lastAutoRunDate: null,
      hasPending: true,
    }),
    timeOnDate(THURSDAY, '18:00'),
  )
  const after = timeOnDate(THURSDAY, '19:00')
  assert.equal(
    nextScheduledRun({
      now: after,
      runAt: '18:00',
      offPeakOnly: true,
      holidays: [],
      lastAutoRunDate: null,
      hasPending: true,
    }),
    timeOnDate(THURSDAY, '18:00'),
  )
  assert.equal(
    nextScheduledRun({
      now: after,
      runAt: '18:00',
      offPeakOnly: true,
      holidays: [],
      lastAutoRunDate: THURSDAY,
      hasPending: false,
    }),
    timeOnDate(addDays(THURSDAY, 1), '18:00'),
  )
})

test('calendar helpers are stable', () => {
  assert.equal(addDays(THURSDAY, 1), '2026-10-23')
  assert.equal(previousDate(THURSDAY), '2026-10-21')
  assert.equal(isDateString('2026-10-22'), true)
  assert.equal(isDateString('2026-02-30'), false)
  assert.equal(isDateString('2026-1-1'), false)
  assert.deepEqual(parseHHMM('00:05'), { hour: 0, minute: 5 })
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(formatTokens(1234), '1.2K')
  assert.equal(formatMoney(0.00032), '¥0.0003')
})

test('priceUsage prices known models at the sample instant', () => {
  const usage = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 50 }
  const peak = priceUsage(usage, 'deepseek-flash', timeOnDate(THURSDAY, '10:00'))
  assert.ok(peak)
  assert.equal(peak.tier, 'peak')
  assert.ok(Math.abs(peak.cost - 0.00064) < 1e-12)
  const off = priceUsage(usage, 'deepseek-flash', timeOnDate(THURSDAY, '12:00'))
  assert.ok(off)
  assert.equal(off.tier, 'offPeak')
  assert.ok(Math.abs(off.cost - 0.00032) < 1e-12)
  assert.equal(priceUsage(usage, 'unknown-model', timeOnDate(THURSDAY, '12:00')), null)
})

function messageEvent({ turn = 1, step = 1, time, input = 100, read = 0, write = 0, output = 10, model = 'deepseek-flash', text = 'done' }) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write },
      message: { source: { provider: 'deepseek-official', model }, content: text === null ? [] : [{ type: 'text', text }] },
    },
  }
}

test('foldUsage dedupes a step and prefers the message sample', () => {
  const time = timeOnDate(THURSDAY, '12:00')
  const attempt = { ...messageEvent({ time, input: 999, output: 999 }) }
  attempt.type = 'assistant/attempt'
  attempt.data = { turn: 1, step: 1, usage: { inputTokens: 999, outputTokens: 999 } }
  const folded = foldUsage([attempt, messageEvent({ time, input: 100, read: 1000, output: 50 })])
  assert.equal(folded.samples, 1)
  assert.equal(folded.usage.inputTokens, 100)
  assert.equal(folded.usage.cacheReadTokens, 1000)
  assert.equal(folded.usage.outputTokens, 50)
  assert.equal(folded.usage.totalTokens, 1150)
  assert.ok(Math.abs(folded.cost.cny - 0.00032) < 1e-12)
  assert.equal(folded.cost.offPeakCny, folded.cost.cny)
  assert.deepEqual(folded.models, ['deepseek-flash'])
})

test('foldUsage keeps the first attempt when no message exists and skips retries', () => {
  const time = timeOnDate(THURSDAY, '12:00')
  const first = { type: 'assistant/attempt', time, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } }
  const retry = { type: 'assistant/attempt', time, data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 2 } } }
  const folded = foldUsage([first, retry])
  assert.equal(folded.samples, 1)
  assert.equal(folded.usage.inputTokens, 10)
})

test('foldUsage filters by event time and reports unknown models', () => {
  const early = messageEvent({ time: timeOnDate(THURSDAY, '08:00'), model: 'mystery-model' })
  const inside = messageEvent({ time: timeOnDate(THURSDAY, '12:00'), turn: 2, step: 1 })
  const folded = foldUsage([early, inside], {
    from: timeOnDate(THURSDAY, '12:00'),
    to: timeOnDate(THURSDAY, '13:00'),
  })
  assert.equal(folded.samples, 1)
  assert.deepEqual(folded.cost.unknownModels, [])
  const unknown = foldUsage([early])
  assert.equal(unknown.samples, 1)
  assert.equal(unknown.cost.cny, 0)
  assert.deepEqual(unknown.cost.unknownModels, ['mystery-model'])
})

test('addUsage and emptyUsage compose', () => {
  const a = { usage: { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, totalTokens: 10 }, cost: { cny: 1, peakCny: 1, offPeakCny: 0, unknownModels: [] }, models: ['a'], samples: 1 }
  const b = { usage: { inputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7, outputTokens: 8, totalTokens: 26 }, cost: { cny: 2, peakCny: 0, offPeakCny: 2, unknownModels: ['x'] }, models: ['b'], samples: 2 }
  const sum = addUsage(a, b)
  assert.equal(sum.usage.totalTokens, 36)
  assert.equal(sum.cost.cny, 3)
  assert.deepEqual(sum.models.sort(), ['a', 'b'])
  assert.deepEqual(sum.cost.unknownModels, ['x'])
  assert.equal(emptyUsage().samples, 0)
})

test('message, turn-end, prompt and tool helpers', () => {
  const time = timeOnDate(THURSDAY, '12:00')
  const events = [
    { type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我调研竞品' }] } },
    { type: 'tool/call', time, data: { name: 'web_search' } },
    { type: 'tool/call', time, data: { name: 'web_search' } },
    messageEvent({ time, text: '最终结果' }),
    { type: 'turn/end', time, data: { reason: { kind: 'completed' } } },
  ]
  assert.equal(lastAssistantText(events), '最终结果')
  assert.equal(lastTurnEnd(events).kind, 'completed')
  assert.equal(firstUserText(events), '帮我调研竞品')
  assert.deepEqual(countToolCalls(events), { web_search: 2 })
  assert.equal(outcomeOfTurnEnd({ kind: 'error' }), 'failed')
  assert.equal(outcomeOfTurnEnd({ kind: 'aborted', reason: 'x' }), 'cancelled')
  assert.equal(inferKind('帮我调研竞品', {}), 'research')
  assert.equal(inferKind('随便做点事', { write: 3 }), 'dev')
  assert.equal(titleLine('[[dsh-task-plan]] 任务：修复登录 bug（类型：开发）\n正文'), '任务：修复登录 bug（类型：开发）')
})
