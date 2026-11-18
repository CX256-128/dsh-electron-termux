/**
 * DeepSeek Harness desktop shell for Termux.
 *
 * The window renders the upstream Web GUI: the shell starts `dsh web`, reads the
 * entry URL it prints, and loads it with the same window caption the reference
 * desktop application uses (`html[data-windows-titlebar]`, a 40px caption row,
 * the Application/Edit menubar and native window controls). Only the chrome is
 * ours; every pixel of the application comes from the installed dsh package.
 */

// Electron's ESM loader exposes the built-in module as named exports only.
import {
  app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell,
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from './backend.mjs'
import { applicationTemplate, captionLabels, contextTemplate, editTemplate } from './menus.mjs'
import { resolveDesktopLocale } from './locale.mjs'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const PRODUCT_NAME = 'DeepSeek Harness'
/** A slow Termux cold start can paint late; never leave the user with no window. */
const SHOW_FALLBACK_MS = 8_000

const options = parseArguments(process.argv.slice(1))
const isTermux = process.platform === 'linux'
  && (process.env.TERMUX_VERSION !== undefined || (process.env.PREFIX ?? '').includes('/com.termux/'))

// Chromium's setuid and user-namespace sandboxes are unusable on Android, and
// Android ships no /dev/shm large enough for a renderer.
if (isTermux) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  if ((process.env.WAYLAND_DISPLAY ?? '') === '') app.commandLine.appendSwitch('ozone-platform', 'x11')
}
/**
 * Chromium compositing presets for Termux's X11 stack.
 *
 * `gpu` is Chromium's default (GPU raster + GPU display compositor). On
 * Termux:X11 that display path reports damaged regions through ANGLE→zink→
 * Vulkan, and a chat view that repaints constantly (streaming text, sticky
 * composer, composited layers) can smear stale regions or flicker. `memory`
 * keeps GPU rasterization but composites and presents whole buffers from the
 * CPU, which is the path termux-x11 handles most reliably.
 */
const RENDER_MODES = {
  gpu: [],
  memory: [['disable-gpu-compositing']],
  software: [['disable-gpu']],
  swiftshader: [['use-gl', 'angle'], ['use-angle', 'swiftshader']],
}

/** @returns the preselected render mode, honoring `--render` and `DSH_APP_RENDER`. */
function renderMode() {
  const requested = options.render !== '' ? options.render : (process.env.DSH_APP_RENDER ?? '')
  if (requested === '' || requested === 'auto') return isTermux ? 'memory' : 'gpu'
  if (RENDER_MODES[requested] === undefined) {
    console.warn(`dsh-app: unknown render mode "${requested}", using auto`)
    return isTermux ? 'memory' : 'gpu'
  }
  return requested
}

const render = renderMode()
console.log(`dsh-app: render mode ${render}`)
for (const [name, value] of RENDER_MODES[render]) {
  if (value === undefined) app.commandLine.appendSwitch(name)
  else app.commandLine.appendSwitch(name, value)
}

for (const flag of (process.env.DSH_APP_FLAGS ?? '').split(/\s+/u)) {
  if (flag === '') continue
  const trimmed = flag.replace(/^--/u, '')
  const eq = trimmed.indexOf('=')
  if (eq === -1) app.commandLine.appendSwitch(trimmed)
  else app.commandLine.appendSwitch(trimmed.slice(0, eq), trimmed.slice(eq + 1))
}

app.setName(PRODUCT_NAME)

/** @type {BrowserWindow | undefined} */
let mainWindow
/** @type {Awaited<ReturnType<typeof startBackend>> | undefined} */
let backend
/** Entry URL the window should show; empty until a backend advertises one. */
let entryUrl = ''
let retrying = false

/**
 * Read the shell's own flags. Electron forwards everything after the app path,
 * and the launcher may add Chromium switches, so only known flags are consumed.
 * @param argv - process arguments without the executable.
 * @returns the parsed shell options.
 */
function parseArguments(argv) {
  const parsed = { url: process.env.DSH_APP_URL ?? '', screenshot: '', devtools: false, alwaysOnTop: false, render: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const separator = argument.indexOf('=')
    const key = separator === -1 ? argument : argument.slice(0, separator)
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    if (key === '--url') parsed.url = inline ?? argv[++index] ?? ''
    else if (key === '--screenshot') parsed.screenshot = inline ?? argv[++index] ?? ''
    else if (key === '--devtools') parsed.devtools = true
    else if (key === '--always-on-top') parsed.alwaysOnTop = true
    else if (key === '--render') parsed.render = inline ?? argv[++index] ?? ''
  }
  return parsed
}

/** Sidebar fill the reference shell paints behind the workspace until the page paints. */
function chromeFallbackFill() {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'
}

/** Language the Web UI is rendering in, learned from the preload's caption labels. */
let shellLanguage = ''

function currentMessages() {
  return resolveDesktopLocale(shellLanguage !== '' ? shellLanguage : app.getLocale()).messages
}

/**
 * Accept IPC only from the window this shell owns.
 * @param event - the IPC event under inspection.
 * @returns whether the sender is the main frame of the application window.
 */
function ownedSender(event) {
  return mainWindow !== undefined
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
}

/**
 * Escape text interpolated into the fallback document.
 * @param value - untrusted text.
 * @returns HTML-escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * A failure document matching the workspace palette.
 *
 * The document follows `prefers-color-scheme`, which the shell keeps equal to
 * the application's own theme through `nativeTheme`, so a light-theme window
 * does not flash to a dark page.
 * @param messages - localized shell copy.
 * @param detail - technical failure text.
 * @returns a self-contained HTML document.
 */
function failureDocument(messages, detail) {
  // The caption menubar reads `lang` for its labels, so the failure document
  // carries the application language rather than a hard-coded English tag.
  const language = shellLanguage !== '' ? shellLanguage : app.getLocale()
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark;
    --bg: light-dark(#f9fafb, #1b1b1c);
    --label: light-dark(#0f1115, #f9fafb);
    --muted: light-dark(#61666b, #b7b7b9);
    --panel: light-dark(#eeeff1, #111112); }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-content: center; gap: 12px; padding: 32px; background: var(--bg); color: var(--label);
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  p { margin: 0; color: var(--muted); max-width: 560px; }
  pre { margin: 0; padding: 12px; max-width: 560px; max-height: 240px; overflow: auto; border-radius: 8px;
    background: var(--panel); color: var(--muted); font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
  button { justify-self: start; padding: 6px 14px; border: 0; border-radius: 6px; background: #4d6bfe; color: #fff;
    font: inherit; cursor: pointer; }
</style></head><body>
<h1>${escapeHtml(messages.startupFailed ?? 'DeepSeek Harness is unavailable')}</h1>
<p>${escapeHtml(messages.fatalSummary ?? 'The application could not start or stopped unexpectedly.')}</p>
<pre>${escapeHtml(detail)}</pre>
<button onclick="retry()">${escapeHtml(messages.restartApplication ?? 'Restart')}</button>
<script>
  // Retry must reload the application URL (or restart the backend), never this
  // failure document, so the page asks main through the preload bridge.
  function retry() {
    if (globalThis.__DSH_SHELL__) { void __DSH_SHELL__.retry(); return }
    location.reload()
  }
</script>
</body></html>`
}

/**
 * Replace the window content with the failure document.
 * @param window - the application window.
 * @param detail - technical failure text.
 * @returns a promise that resolves once the document loaded.
 */
async function showFailure(window, detail) {
  if (window.isDestroyed()) return
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(failureDocument(currentMessages(), detail))}`
  await window.loadURL(page)
}

/**
 * Retry the application load from a failure document.
 *
 * A backend that never started (or died) is restarted first; the window then
 * loads the entry URL the new server printed. Any failure lands back on the
 * same document with the new diagnostic instead of trapping the user there.
 * @param window - the application window that asked for the retry.
 */
async function retryApplication(window) {
  if (retrying || window.isDestroyed()) return
  retrying = true
  try {
    // Only a server this shell started may be restarted; a `--url` target is
    // somebody else's process and only gets another load.
    if (options.url === '' && (backend === undefined || !backend.alive())) {
      backend?.stop()
      backend = await startBackend((line) => { console.log(`[dsh] ${line}`) })
      entryUrl = backend.url
    }
    await window.loadURL(entryUrl)
  } catch (error) {
    await showFailure(window, error instanceof Error ? error.message : String(error))
  } finally {
    retrying = false
  }
}

/**
 * Create the single application window around an entry URL.
 * @param url - the Web GUI entry URL.
 * @returns the created window.
 */
function createWindow(url) {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.max(520, Math.min(1280, workArea.width))
  const height = Math.max(480, Math.min(820, workArea.height))

  const window = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(520, width),
    minHeight: Math.min(600, height),
    show: false,
    frame: false,
    backgroundColor: chromeFallbackFill(),
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(APP_DIR, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
      devTools: true,
    },
  })

  window.setMenuBarVisibility(false)
  // Diagnostic aid: keep the shell above other windows (screenshot probes and
  // renderer comparisons need the window unobstructed).
  if (options.alwaysOnTop) window.setAlwaysOnTop(true, 'screen-saver')

  // `ready-to-show` never fires when the first paint is starved (the GPU path
  // on Termux can take a while), and a window that stays hidden is unreachable.
  let revealed = false
  const reveal = () => {
    if (revealed || window.isDestroyed()) return
    revealed = true
    window.show()
    window.focus()
  }
  const showTimer = setTimeout(reveal, SHOW_FALLBACK_MS)
  window.once('ready-to-show', reveal)
  window.once('closed', () => { clearTimeout(showTimer) })

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    let parsed
    try { parsed = new URL(target) } catch { return { action: 'deny' } }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(target)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, target) => {
    let next
    let current
    try {
      next = new URL(target)
      current = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    if (next.origin === current.origin) return
    event.preventDefault()
    if (next.protocol === 'http:' || next.protocol === 'https:') void shell.openExternal(target)
  })

  window.webContents.on('before-input-event', (event, input) => {
    // The window has no native menu, so no accelerator is registered for the
    // Application menu's Reload entry; honor the same keys here.
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const key = input.key.toLowerCase()
    const reload = key === 'f5' || (key === 'r' && (input.control || input.meta) && !input.shift && !input.alt)
    if (!reload) return
    event.preventDefault()
    window.webContents.reload()
  })

  window.webContents.on('did-finish-load', () => {
    sendWindowState(window)
    if (options.devtools) window.webContents.openDevTools({ mode: 'detach' })
    if (options.screenshot !== '') void captureAndExit(window, options.screenshot)
  })

  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED (a superseded navigation), and the failure document
    // itself must never be replaced by another copy of itself.
    if (!isMainFrame || code === -3 || validatedUrl.startsWith('data:')) return
    const detail = `URL: ${validatedUrl}\nError: ${description} (${code})`
    void showFailure(window, detail)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    const messages = currentMessages()
    void dialog.showMessageBox(window, {
      type: 'error',
      title: PRODUCT_NAME,
      message: messages.startupFailed ?? 'The application window stopped',
      detail: `${details.reason} (exit code ${details.exitCode})`,
      buttons: [messages.restartApplication ?? 'Restart', messages.updateAcknowledge ?? 'OK'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !window.isDestroyed()) window.reload()
    })
  })

  window.webContents.on('context-menu', (_event, params) => {
    const items = contextTemplate(currentMessages(), params.editFlags, params.selectionText)
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window })
  })

  for (const [event, state] of [['maximize', 'maximized'], ['unmaximize', 'unmaximized'],
    ['restore', 'restored'], ['enter-full-screen', 'fullscreen'], ['leave-full-screen', 'windowed']]) {
    window.on(event, () => { sendWindowState(window, state) })
  }
  window.on('closed', () => { mainWindow = undefined })

  void window.loadURL(url)
  return window
}

/**
 * Mirror the window state to the page so the caption controls and the Web UI's
 * fullscreen clearance agree with the native window.
 * @param window - the application window.
 * @param state - the state the transition produced, or a full snapshot.
 */
function sendWindowState(window, state = '') {
  if (window.isDestroyed()) return
  window.webContents.send('dsh:window-state', {
    state,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  })
}

/**
 * Dev helper: wait for the first paint, write a PNG, and exit.
 * @param window - the application window.
 * @param target - the PNG path.
 */
async function captureAndExit(window, target) {
  // A fixed delay only guesses when the first frame exists; wait for the load
  // to finish (bounded) and let one paint land before capturing.
  const deadline = Date.now() + 15_000
  while (window.webContents.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  await new Promise((resolve) => { setTimeout(resolve, 1_500) })
  try {
    const image = await window.webContents.capturePage()
    await writeFile(target, image.toPNG())
    console.log(`screenshot: ${target}`)
  } catch (error) {
    console.error('screenshot failed', error)
  }
  app.quit()
}

/** Register every channel the preload bridge can reach. */
function registerIpc() {
  ipcMain.handle('dsh:window', (event, action) => {
    if (!ownedSender(event) || mainWindow === undefined) throw new Error('rejected')
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'toggle-maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (action === 'close') mainWindow.close()
    else throw new Error('unknown window action')
  })

  ipcMain.on('dsh:theme', (event, source) => {
    if (!ownedSender(event)) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })

  ipcMain.handle('dsh:directory-pick', async (event) => {
    if (!ownedSender(event) || mainWindow === undefined) throw new Error('rejected')
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: currentMessages().chooseFolder ?? 'Choose a folder',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.on('dsh:caption-labels', (event, language) => {
    // Native menus follow the application's own language, not the OS locale.
    if (typeof language === 'string' && language !== '') shellLanguage = language
    event.returnValue = typeof language === 'string' ? captionLabels(language) : captionLabels('en')
  })

  ipcMain.handle('dsh:caption-menu', (event, name, x, y) => {
    if (!ownedSender(event) || mainWindow === undefined) return
    if (name !== 'application' && name !== 'edit') return
    const messages = currentMessages()
    const template = name === 'application'
      ? applicationTemplate(messages, {
        about: () => { void showAbout() },
        checkUpdates: () => { void showUpdateGuidance() },
        reload: () => { if (mainWindow !== undefined) mainWindow.webContents.reload() },
      })
      : editTemplate(messages)
    const zoom = mainWindow.webContents.getZoomFactor()
    return new Promise((resolve) => {
      Menu.buildFromTemplate(template).popup({
        window: mainWindow,
        x: Math.round(Number(x) * zoom),
        y: Math.round(Number(y) * zoom),
        callback: resolve,
      })
    })
  })

  ipcMain.handle('dsh:retry', async (event) => {
    if (!ownedSender(event) || mainWindow === undefined) return
    await retryApplication(mainWindow)
  })
}

/** Show the About dialog the reference shell owns on Windows. */
async function showAbout() {
  const messages = currentMessages()
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: PRODUCT_NAME,
    message: PRODUCT_NAME,
    detail: [
      messages.aboutVersion?.replace('{version}', app.getVersion()) ?? `Version V${app.getVersion()}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      isTermux ? 'Termux (Android, Bionic libc)' : `${process.platform} ${process.arch}`,
    ].join('\n'),
    buttons: [messages.updateAcknowledge ?? 'OK'],
  })
}

/** This frontend is updated through npm, so updates are guidance rather than a downloader. */
async function showUpdateGuidance() {
  const messages = currentMessages()
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: PRODUCT_NAME,
    message: messages.checkUpdatesMenu,
    detail: 'npm install -g @deepseek-ai/dsh@latest',
    buttons: [messages.updateAcknowledge ?? 'OK'],
  })
}

/** Start the backend when needed and open the window on its entry URL. */
async function boot() {
  registerIpc()
  Menu.setApplicationMenu(null)

  entryUrl = options.url
  let failure = ''
  if (entryUrl === '') {
    try {
      backend = await startBackend((line) => { console.log(`[dsh] ${line}`) })
      entryUrl = backend.url
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }

  // The failure document is still rendered in the real window chrome: the
  // caption's close button is the only way out on a device without a taskbar.
  mainWindow = failure === ''
    ? createWindow(entryUrl)
    : createWindow(`data:text/html;charset=utf-8,${encodeURIComponent(failureDocument(currentMessages(), failure))}`)
  nativeTheme.on('updated', () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(chromeFallbackFill())
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(boot).catch((error) => {
    console.error(error)
    app.quit()
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('activate', () => {
    if (mainWindow === undefined) return
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('before-quit', () => { stopBackend() })

  app.on('will-quit', () => { stopBackend() })
}

/**
 * Stop the Web GUI server the shell owns, once.
 *
 * The child is a process-group leader (see backend.mjs), so one signal reaches
 * every helper it started. Electron does not outlive it: `stop()` escalates on
 * its own, and `app.quit()` has already begun.
 */
function stopBackend() {
  backend?.stop()
  backend = undefined
}

// A terminal Ctrl+C (SIGINT) must not leave `dsh web` behind: the child runs in
// its own process group, so Electron has to forward the shutdown itself.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopBackend()
    app.quit()
  })
}
