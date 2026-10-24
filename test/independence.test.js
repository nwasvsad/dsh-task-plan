import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')

test('the task-plan host never imports the digest package', async () => {
  const names = await fs.readdir(libDir)
  for (const name of names) {
    if (!name.endsWith('.js') || name === 'client.js') continue
    const source = await fs.readFile(path.join(libDir, name), 'utf8')
    assert.equal(
      /(?:from\s*['"][^'"]*dsh-task-digest|require\(\s*['"][^'"]*dsh-task-digest)/.test(source),
      false,
      `${name} must not import dsh-task-digest`,
    )
  }
})
