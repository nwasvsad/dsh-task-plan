/**
 * Read-only verification for the task-plan plugin.
 *
 *   node scripts/verify.mjs           # checks only
 *   node scripts/verify.mjs --apply   # also installs into $DSH_HOME/profiles/web
 *
 * @module dsh-task-plan/scripts/verify
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildBundle, PLUGIN_ID } from './build-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web')
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')
const PROFILE_PACKAGE = path.join(PROFILE_DIR, 'package.json')
const ROW_ID = 'task-plan'
const PLUGIN_NAME = 'dsh-task-plan'

const PATCH_BLOCK = `
# dsh-task-plan: off-peak task plan + nightly digest
- insert:
    - id: ${ROW_ID}
      name: ${PLUGIN_NAME}
      config:
        dataDir: '~/.dsh/task-plan'
        defaultCwd: '~'
        runAt: '18:00'
        offPeakOnly: true
        concurrency: 2
        holidays: []
`.trimEnd()

let failures = 0

/**
 * Report one check.
 * @param {boolean} condition Whether the check passed.
 * @param {string} label Check label.
 * @param {string} [detail] Detail on failure.
 */
function check(condition, label, detail = '') {
  if (condition) {
    process.stdout.write(`ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/**
 * Read a file as UTF-8, or return null when absent.
 * @param {string} file Path.
 * @returns {Promise<string | null>}
 */
async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  const packageText = await fs.readFile(path.join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(packageText)
  check(pkg.name === PLUGIN_NAME, 'package name', pkg.name)
  check(pkg.type === 'module', 'package is ESM', pkg.type)
  check(pkg.main === 'lib/index.js', 'main points at the host half')
  const clientExport = pkg.exports?.['./client']
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
  check(clientPath === './lib/client.js', 'client export points at the bundle')
  check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform is web')
  check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch is declared for the plugin market')
  check(pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion is 1')
  check(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.includes('0.2.1-rc.2'), 'engines.dsh declares the tested runtime')
  check(pkg.files?.includes('cordis.patch.yml'), 'published files include the bundle patch')
  check(pkg.files?.includes('icon.svg'), 'published files include the icon')
  check(pkg.repository?.url?.includes(PLUGIN_NAME) && pkg.repository.url.includes('github.com'), 'repository metadata points at GitHub')

  const bundlePatch = await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
  check(bundlePatch.includes(`name: ${PLUGIN_NAME}`), 'cordis.patch.yml inserts this package')
  check(await fs.readFile(path.join(root, 'icon.svg'), 'utf8').then(() => true, () => false), 'icon.svg exists')

  const source = await fs.readFile(path.join(root, 'src', 'client.js'), 'utf8')
  check(!/^\s*(?:import|export)\b/m.test(source), 'client source has no ESM statements')
  check(source.includes("const inject = ['slots', 'locale', 'uiWorkspace']"), 'client source declares its inject list')

  const built = buildBundle(source)
  const bundle = await fs.readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  check(bundle === built, 'lib/client.js is current (run npm run build)')
  check(bundle.includes(`id: ${JSON.stringify(PLUGIN_ID)}`), 'bundle id matches the package name')
  let parsed = true
  try {
    // Parses the bundle without executing it; the module-loader call needs a browser.
    // eslint-disable-next-line no-new-func
    new Function(bundle)
  } catch (error) {
    parsed = false
    check(false, 'bundle parses as JavaScript', String(error?.message ?? error))
  }
  if (parsed) check(true, 'bundle parses as JavaScript')

  let host = null
  try {
    host = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  } catch (error) {
    check(false, 'host half imports', String(error?.message ?? error))
  }
  if (host !== null) {
    check(host.name === PLUGIN_NAME, 'host name export', host.name)
    const expected = ['webServer', 'connection', 'sessionQuery', 'sessionController', 'subagents']
    check(expected.every((service) => host.inject.includes(service)), 'host inject includes every required service')
    const config = host.resolveConfig({
      dataDir: path.join(root, '.tmp-check'),
      runAt: '18:00',
      concurrency: 2,
      holidays: ['2026-10-01'],
    })
    check(config.runAt === '18:00' && config.concurrency === 2, 'config normalization keeps valid values')
    check(config.holidays.length === 1, 'config normalization keeps holidays')
    const safe = host.resolveConfig({ runAt: '99:99', concurrency: 99, offPeakOnly: 'yes' })
    check(safe.runAt === '18:00' && safe.concurrency === 8 && safe.offPeakOnly === true, 'config normalization clamps invalid values')
  }

  const patch = await readOptional(PATCH_FILE)
  check(patch !== null, 'web profile patch exists', PATCH_FILE)
  if (patch !== null) {
    check(!patch.includes('\uFFFD'), 'web profile patch is valid UTF-8')
    check(patch.includes(`id: ${ROW_ID}`), `web profile carries the ${ROW_ID} row`)
  }

  const profilePackage = await readOptional(PROFILE_PACKAGE)
  if (profilePackage !== null) {
    try {
      const parsedProfile = JSON.parse(profilePackage)
      check(
        parsedProfile.dependencies?.[PLUGIN_NAME] !== undefined,
        'web profile depends on the plugin',
        'run node scripts/verify.mjs --apply',
      )
    } catch (error) {
      check(false, 'web profile package.json parses', String(error?.message ?? error))
    }
  }

  if (process.argv.includes('--apply')) await apply()
  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

async function apply() {
  const patch = await readOptional(PATCH_FILE)
  if (patch === null) {
    process.stdout.write(`FAIL cannot install: missing ${PATCH_FILE}\n`)
    failures += 1
    return
  }
  if (!patch.includes(`id: ${ROW_ID}`)) {
    const next = `${patch.trimEnd()}\n\n${PATCH_BLOCK}\n`
    await fs.writeFile(PATCH_FILE, next, 'utf8')
    process.stdout.write(`ok   appended the ${ROW_ID} row to ${PATCH_FILE}\n`)
  } else {
    process.stdout.write(`ok   ${ROW_ID} row already present; left untouched\n`)
  }
  const spec = `${PLUGIN_NAME}@file:${root.replace(/\\/g, '/')}`
  try {
    execFileSync('pnpm', ['add', spec], { cwd: PROFILE_DIR, stdio: 'inherit', shell: true })
    const profilePackage = JSON.parse(await fs.readFile(PROFILE_PACKAGE, 'utf8'))
    check(profilePackage.dependencies?.[PLUGIN_NAME] !== undefined, 'profile package.json depends on the plugin')
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL pnpm add in the profile directory — ${String(error?.message ?? error)}\n`)
  }

  const finalPatch = await fs.readFile(PATCH_FILE, 'utf8')
  check(!finalPatch.includes('\uFFFD'), 'installed patch file is valid UTF-8')
  let YAML
  for (const base of [PROFILE_DIR, root]) {
    try {
      YAML = createRequire(path.join(base, 'package.json'))('yaml')
      break
    } catch {
      // Try the next base.
    }
  }
  if (YAML === undefined) {
    process.stdout.write('skip YAML parse (no yaml package available)\n')
    return
  }
  try {
    const parsed = YAML.parse(finalPatch)
    const row = parsed
      .flatMap((entry) => entry?.insert ?? [])
      .find((item) => item?.id === ROW_ID)
    check(row !== undefined && row.name === PLUGIN_NAME, 'patch parses to the task-plan row')
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL patch file parses as YAML — ${String(error?.message ?? error)}\n`)
  }
}

await main()
