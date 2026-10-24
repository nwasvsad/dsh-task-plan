/**
 * In-process test entry point.
 *
 * `node --test` spawns one child process per file, which fails inside the DSH
 * file sandbox (pipes are not available). Importing every suite into one
 * process keeps `npm test` usable in both environments.
 */
await import('./core.test.js')
await import('./plan.test.js')
await import('./runner.test.js')
await import('./scheduler.test.js')
await import('./routes.test.js')
await import('./client.test.js')
await import('./apply.test.js')
await import('./independence.test.js')
await import('./integration.test.js')
