/**
 * Headless visual check for the shell's window chrome.
 *
 * This session cannot create native windows, so Electron cannot render here.
 * The caption, though, is DOM the preload injects into the same Web GUI, so a
 * headless Chromium can show exactly what the Electron window shows: the same
 * document, the same `data-windows-titlebar` contract, the same 40px caption
 * with the Application/Edit menubar and the three window buttons.
 *
 * Usage: node tools/preview.mjs [url] [out.png] [width] [height]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2] ?? 'http://127.0.0.1:53120'
const output = process.argv[3] ?? join(root, 'preview.png')
const width = Number(process.argv[4] ?? 1280)
const height = Number(process.argv[5] ?? 820)

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
const browser = CANDIDATES.find((candidate) => existsSync(candidate))
if (browser === undefined) {
  console.error('no Chromium-based browser found for the preview')
  process.exit(1)
}

/** Mirrors app/preload.cjs: same attributes, same caption DOM, same styles. */
const PREVIEW_SCRIPT = `
(() => {
  const CAPTION_HEIGHT = 40
  const paint = () => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', CAPTION_HEIGHT + 'px')

    const controls = document.createElement('div')
    controls.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483000;'
    const shadow = controls.attachShadow({ mode: 'open' })
    shadow.innerHTML = \`
      <style>
        .bar { display: flex; height: 40px; -webkit-app-region: no-drag; }
        .control { width: 46px; height: 100%; border: 0; display: grid; place-items: center;
          background: transparent; color: var(--dsw-alias-label-secondary, #777); }
        .control:hover { background: color-mix(in srgb, currentColor 9%, transparent);
          color: var(--dsw-alias-label-primary, currentColor); }
        .close:hover { background: #e81123; color: #fff; }
        svg { width: 10px; height: 10px; display: block; }
        svg :is(path, rect, line) { fill: none; stroke: currentColor; stroke-width: 1; }
      </style>
      <div class="bar">
        <button class="control"><svg viewBox="0 0 10 10"><line x1="0.5" y1="5" x2="9.5" y2="5"/></svg></button>
        <button class="control"><svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9"/></svg></button>
        <button class="control close"><svg viewBox="0 0 10 10"><path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"/></svg></button>
      </div>\`
    root.append(controls)

    const menu = document.createElement('div')
    menu.dataset.windowsMenu = ''
    const menuShadow = menu.attachShadow({ mode: 'open' })
    menuShadow.innerHTML = \`
      <style>
        :host { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 1100;
          height: var(--dsh-windows-titlebar-height, 40px); display: flex; align-items: center;
          font-family: var(--dsw-font-family, system-ui, sans-serif); }
        [role=menubar] { display: flex; gap: 2px; }
        button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
          color: var(--dsw-alias-label-secondary, #777); font: inherit; font-size: 14px; }
      </style>
      <div role="menubar"><button>应用</button><button>编辑</button></div>\`
    const mount = () => {
      if (document.querySelector('[data-shell-overlay]') === null) return
      ;(document.body ?? document.documentElement).append(menu)
      observer.disconnect()
    }
    const observer = new MutationObserver(mount)
    // <body> may not exist yet at document-start, so watch the root subtree.
    observer.observe(document.documentElement, { childList: true, subtree: true })
    mount()
  }
  // Evaluate-on-new-document runs before the parser creates <html>.
  const waitForRoot = () => {
    if (document.documentElement !== null) paint()
    else setTimeout(waitForRoot, 0)
  }
  waitForRoot()
})()`

const bridge = process.argv.includes('--bridge')

/** Mirrors the bridges app/preload.cjs exposes, so plugin gating can be tested. */
const BRIDGE_SCRIPT = `
(() => {
  Object.defineProperty(window, '__DSH_DIRECTORY_PICKER__', { value: { pick: async () => null }, configurable: true })
  Object.defineProperty(window, '__DSH_HOST_PATHS__', { value: { pathFor: () => '' }, configurable: true })
})()`

/** Minimal CDP client over the built-in WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
  }

  async waitFor(method, timeoutMs = 30_000) {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.removeEventListener('message', listener); reject(new Error(`timeout waiting for ${method}`)) }, timeoutMs)
      const listener = (event) => {
        const message = JSON.parse(event.data)
        if (message.method !== method) return
        clearTimeout(timer)
        this.socket.removeEventListener('message', listener)
        resolve(message.params)
      }
      this.socket.addEventListener('message', listener)
    })
  }
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-preview-'))
const portFile = join(profile, 'DevToolsActivePort')
const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--user-data-dir=' + profile,
  '--remote-debugging-port=0',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

try {
  let port
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) {
      port = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (port !== '') break
    }
    await sleep(100)
  }
  if (port === undefined || port === '') throw new Error('browser did not open a debugging port')

  let target
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await response.json()
    target = targets.find((entry) => entry.type === 'page')
    if (target !== undefined) break
    await sleep(100)
  }
  if (target === undefined) throw new Error('no page target')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(socket)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PREVIEW_SCRIPT })
  if (bridge) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_SCRIPT })
  cdp.send('Page.navigate', { url }).catch(() => undefined)
  await cdp.waitFor('Page.loadEventFired').catch(() => undefined)
  await sleep(4_000)

  const probe = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      overlay: document.querySelectorAll('[data-shell-overlay]').length,
      menuStart: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start'),
      caption: document.documentElement.dataset.windowsTitlebar !== undefined,
      menuMounted: document.querySelector('[data-windows-menu]') !== null,
      menuBox: (() => {
        const host = document.querySelector('[data-windows-menu]')
        if (host === null) return null
        const rect = host.getBoundingClientRect()
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      })(),
      pluginsFailed: document.body.innerText.includes('Failed to load plugins'),
      lang: document.documentElement.lang,
    })`,
  })
  console.log('dom:', probe.result?.value)

  // Dismiss the preview notice so the window shows the conversation surface.
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const button = [...document.querySelectorAll('button')]
      .find(node => /^(继续|Continue)$/.test(node.textContent?.trim() ?? ''))
      if (button === undefined) return false
      button.click()
      return true })()`,
    returnByValue: true,
  })
  await sleep(800)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(output, Buffer.from(shot.data, 'base64'))
  console.log(`preview: ${output}`)
} finally {
  child.kill()
  await sleep(500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser may still hold a handle */ }
}

