/**
 * Client-bundle generator.
 *
 * The DSH web client loads a plugin's browser half as a `window.__ModuleLoader__`
 * row: a script that only registers a factory, whose body is materialized with
 * a CJS-style `require` seeded from the platform (`react`, `react/jsx-runtime`).
 * This script wraps `src/client.js` in exactly that shape.
 *
 * @module dsh-task-plan/scripts/build-client
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin id: the loader row name and the module-table key. */
export const PLUGIN_ID = 'dsh-task-plan'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sourcePath = resolve(root, 'src/client.js')
const outPath = resolve(root, 'lib/client.js')

/**
 * Indent one block inside the factory.
 * @param {string} text Source text.
 * @returns {string}
 */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `\t\t${line}`))
    .join('\n')
}

/**
 * Wrap one browser source in the module-loader factory.
 * @param {string} source Browser source (no ESM statements).
 * @returns {string} Complete bundle text.
 */
export function buildBundle(source) {
  const body = source.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '').trim()
  if (/^\s*(?:import|export)\b/m.test(body)) {
    throw new Error('src/client.js must not contain import/export statements')
  }
  return `/**
 * Generated browser bundle for the DSH task-plan plugin. Do not edit:
 * regenerate with \`node scripts/build-client.mjs\`.
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tlet react = require("react");

${indent(body)}

\t\treturn module.exports;
\t}
});
`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = buildBundle(readFileSync(sourcePath, 'utf8'))
  writeFileSync(outPath, bundle, 'utf8')
  process.stdout.write(`wrote ${outPath} (${bundle.length} bytes)\n`)
}
