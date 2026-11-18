/**
 * Development launcher.
 *
 * Electron must be invoked from outside `app/`: if `node_modules/electron` is an
 * ancestor of the app directory, the npm package shadows Electron's built-in
 * module and `require('electron')` returns the executable path instead of the
 * API. The dev dependency therefore lives in `dev/`, which is not on `app/`'s
 * resolution path.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dev', 'node_modules', 'electron', 'dist')
const executable = process.platform === 'win32'
  ? join(dist, 'electron.exe')
  : process.platform === 'darwin'
    ? join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(dist, 'electron')

if (!existsSync(executable)) {
  console.error(
    `Electron 未安装：${executable}\n`
    + '先运行：npm install --prefix dev\n'
    + '若二进制下载卡住：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --prefix dev',
  )
  process.exit(1)
}

const child = spawn(executable, [join(root, 'app'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  // Agent shells sometimes export this; it turns electron.exe into plain Node,
  // where every Electron API is missing.
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE')),
})

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
