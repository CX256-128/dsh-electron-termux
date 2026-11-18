/**
 * Owns the `dsh web` child process that serves the Web GUI this shell renders.
 *
 * The shell never re-implements the GUI: it starts the same server a browser
 * would reach, reads the entry URL the server prints, and points the window at
 * it. Everything inside the window is therefore the upstream bundle.
 */

import { spawn } from 'node:child_process'

/** The server prints `label: url` lines once the listener and plugins are ready. */
const ENTRY_URL = /https?:\/\/[^\s"'<>]+/u

/** Cold starts load dozens of plugin bundles; Termux devices are slower than a desktop. */
const STARTUP_TIMEOUT_MS = 180_000

/** Grace period between SIGTERM and SIGKILL when the server ignores the first signal. */
const KILL_GRACE_MS = 5_000

/**
 * Describe how to invoke the installed dsh CLI on this platform.
 * @returns the command and whether a shell is required to resolve it.
 */
export function resolveDshCommand() {
  const configured = process.env.DSH_BIN
  if (configured !== undefined && configured !== '') return { command: configured, shell: false }
  // npm installs a .cmd shim on Windows, which only a shell resolves from PATH.
  return { command: 'dsh', shell: process.platform === 'win32' }
}

/**
 * Start `dsh web` on a loopback port chosen by the OS.
 * @param onLog - receives every complete output line, for diagnostics.
 * @returns the advertised URL and a disposer that stops the server.
 */
export async function startBackend(onLog = () => undefined) {
  const { command, shell } = resolveDshCommand()
  const args = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open']
  const child = spawn(command, args, {
    shell,
    // Own process group: `dsh web` may start helpers, and stopping the window
    // must not leave any of them running on a phone.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  })

  let tail = ''
  let pending = ''
  let settled = false
  let stopped = false

  const signal = (name) => {
    if (child.pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill(name)
      else process.kill(-child.pid, name)
    } catch {
      try { child.kill(name) } catch { /* already gone */ }
    }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    if (child.exitCode !== null || child.signalCode !== null) return
    signal('SIGTERM')
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
    }, KILL_GRACE_MS)
    force.unref?.()
  }

  return await new Promise((resolve, reject) => {
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) {
        stop()
        reject(error)
        return
      }
      resolve({
        url,
        pid: child.pid,
        // A server can outlive the handshake and die later; a retry must know
        // whether the URL is still worth reloading.
        alive: () => child.exitCode === null && child.signalCode === null,
        stop,
      })
    }

    const timer = setTimeout(() => {
      finish(new Error(`dsh web did not print an entry URL within ${STARTUP_TIMEOUT_MS / 1000}s`))
    }, STARTUP_TIMEOUT_MS)

    const consume = (chunk) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/u)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (text === '') continue
        onLog(text)
        const match = ENTRY_URL.exec(text)
        if (match !== null && match[0].includes('127.0.0.1')) finish(undefined, match[0])
      }
      tail = (tail + chunk.toString()).slice(-8_192)
    }

    // A command that cannot be spawned at all (ENOENT) reports through the
    // `error` event and leaves the pipes unset, so attach only when present.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', (error) => { finish(error) })
    child.on('exit', (code, signalName) => {
      finish(new Error(`dsh web exited before serving (code=${String(code)}, signal=${String(signalName)})\n${tail}`))
    })
  })
}
