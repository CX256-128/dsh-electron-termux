/**
 * Dev helper: start the shell's backend exactly as the app does, publish the
 * entry URL, and keep serving until interrupted.
 *
 * Usage: node tools/dev-backend.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../app/backend.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const backend = await startBackend((line) => { console.log(`[dsh] ${line}`) })
writeFileSync(join(root, 'backend-url.txt'), backend.url)
console.log(`backend ready: ${backend.url}`)

const stop = () => {
  backend.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => undefined, 1_000)
