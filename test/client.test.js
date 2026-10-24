import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
  }
}

function loadClient() {
  const source = readFileSync(bundlePath, 'utf8')
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
    console,
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(definition !== null, 'bundle registered a module definition')
  assert.equal(definition.id, 'dsh-task-plan')
  const react = fakeReact()
  const exported = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { exported, react }
}

function fakeContext(registrations) {
  return {
    effect(fn) {
      const disposable = fn()
      return () => {
        if (typeof disposable === 'function') disposable()
      }
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(_name, fn) {
        return fn()
      },
      register(options) {
        registrations.push(options)
        return () => {}
      },
    },
    uiWorkspace: {
      openSession() {},
    },
  }
}

test('the browser bundle registers the page and the sidebar entry', () => {
  const { exported } = loadClient()
  assert.equal(typeof exported.apply, 'function')
  assert.equal(exported.inject.join(','), 'slots,locale,uiWorkspace')
  const registrations = []
  exported.apply(fakeContext(registrations))
  const main = registrations.find((entry) => entry.name === 'main')
  assert.ok(main, 'main registration exists')
  assert.equal(main.key, 'task-plan')
  assert.equal(main.locale, 'task-plan')
  assert.ok(main.inject().openSession)
  const panel = registrations.find((entry) => entry.name === 'sidebar.panellist')
  assert.ok(panel, 'sidebar entry exists')
  assert.equal(panel.id, 'task-plan')
  assert.equal(panel.order, 10)
  assert.equal(typeof panel.label, 'function')
  assert.equal(registrations.length, 2, 'the plan page registers no digest surface')
})

test('client formatting helpers match the host vocabulary', () => {
  const { exported } = loadClient()
  const { formatTokens, formatMoney, formatDuration } = exported.__test
  assert.equal(formatTokens(1234), '1.2K')
  assert.equal(formatTokens(1_500_000), '1.5M')
  assert.equal(formatTokens(12), '12')
  assert.equal(formatMoney(0.00032), '¥0.0003')
  assert.equal(formatDuration(500), '500ms')
  assert.equal(formatDuration(65_000), '1m 5s')
  assert.equal(formatDuration(3_600_000), '1h 0m')
})

