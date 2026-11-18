/**
 * Preload for the Termux desktop shell.
 *
 * Three jobs, in order of importance:
 *  1. Mark the document the way the reference desktop shell's Windows build does
 *     (`data-windows-titlebar`, 40px caption variable), so the Web UI renders
 *     its desktop layout instead of its browser layout.
 *  2. Draw the window controls and the Application/Edit caption menubar that the
 *     native titlebar would draw on Windows, and forward their actions to main.
 *  3. Expose the optional file bridges the Web UI feature-detects.
 *
 * Sandboxed preload: CommonJS only, and only `electron` plus the DOM are reachable.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** Caption height supplied by the reference shell (apps/desktop/src/windows-layout.ts). */
const CAPTION_HEIGHT = 40
const TITLEBAR_Z_INDEX = '2147483000'
/** Longest wait for the Web client's AppFrame before mounting the menus regardless. */
const MENU_MOUNT_FALLBACK_MS = 4_000

const root = () => /** @type {HTMLElement | null} */ (document.documentElement)

let controlsHost
let menuHost
let fullscreen = false
/** Latest state pushed by main, replayed once the caption DOM exists. */
let windowState = { maximized: false, fullscreen: false }
let started = false

/**
 * Mark the document root with the desktop caption contract.
 *
 * `data-windows-titlebar` is what the Web UI's CSS keys on; `data-platform` is
 * deliberately not set. The Client reads `html[data-platform]` as "desktop
 * runtime" and then requires the full native keyboard/shortcut bridge, which a
 * shell that renders the browser client cannot provide.
 * @returns whether the root existed and was marked.
 */
function markCaption() {
  const element = root()
  if (element === null) return false
  element.dataset.windowsTitlebar = ''
  element.style.setProperty('--dsh-windows-titlebar-height', `${CAPTION_HEIGHT}px`)
  return true
}

/**
 * Build one caption control button.
 * @param name - accessible label and action name.
 * @param glyph - SVG markup for the 10x10 glyph.
 * @param extraClass - additional class name.
 * @returns the button element.
 */
function createControl(name, glyph, extraClass) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `control ${extraClass}`
  button.dataset.action = name
  button.setAttribute('aria-label', name)
  button.innerHTML = `<svg viewBox="0 0 10 10" aria-hidden="true">${glyph}</svg>`
  button.addEventListener('click', () => {
    if (name === 'close') void ipcRenderer.invoke('dsh:window', 'close')
    else if (name === 'minimize') void ipcRenderer.invoke('dsh:window', 'minimize')
    else void ipcRenderer.invoke('dsh:window', 'toggle-maximize')
  })
  return button
}

/**
 * Mount the three native window controls at the caption's trailing edge.
 *
 * The host lives in `<body>`, not on the document root: the Web UI defines its
 * design tokens (`--dsw-alias-*`) on `body`, so a host appended to `<html>`
 * inherits none of them and falls back to plain grey controls that ignore the
 * light/dark palette.
 */
function mountControls() {
  if (controlsHost !== undefined && controlsHost.isConnected) return
  if (document.body === null) return
  const host = document.createElement('div')
  host.id = 'dsh-desktop-window-controls'
  host.style.cssText = `position:fixed;top:0;right:0;z-index:${TITLEBAR_Z_INDEX};`
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { display: block; }
      .bar { display: flex; height: var(--dsh-windows-titlebar-height, 40px); -webkit-app-region: no-drag; }
      .control { width: 46px; height: 100%; margin: 0; padding: 0; border: 0; border-radius: 0;
        display: grid; place-items: center; background: transparent; cursor: default;
        color: var(--dsw-alias-label-secondary, rgb(128, 128, 128));
        -webkit-app-region: no-drag; }
      .control:hover { background: color-mix(in srgb, currentColor 9%, transparent);
        color: var(--dsw-alias-label-primary, currentColor); }
      .control.close:hover { background: #e81123; color: #ffffff; }
      .control:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
        outline-offset: -2px; }
      svg { width: 10px; height: 10px; display: block; overflow: visible; }
      svg :is(path, rect, line) { fill: none; stroke: currentColor; stroke-width: 1; shape-rendering: crispEdges; }
    </style>
    <div class="bar" role="group"></div>`
  const bar = shadow.querySelector('.bar')
  bar.append(
    createControl('minimize', '<line x1="0.5" y1="5" x2="9.5" y2="5"/>', 'minimize'),
    createControl('maximize', '<rect x="0.5" y="0.5" width="9" height="9"/>', 'maximize'),
    createControl('close', '<path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"/>', 'close'),
  )
  document.body.append(host)
  controlsHost = host
  paintMaximized(windowState.maximized === true)
  host.style.display = fullscreen ? 'none' : 'block'
}

/**
 * Swap the maximize glyph between maximize and restore.
 * @param maximized - whether the window is maximized.
 */
function paintMaximized(maximized) {
  const button = controlsHost?.shadowRoot?.querySelector('.maximize')
  if (button === null || button === undefined) return
  button.innerHTML = maximized
    ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5 h7 v7 h-7 z M4.5 2.5 v-2 h7 v7 h-2"/></svg>'
    : '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9"/></svg>'
  button.setAttribute('aria-label', maximized ? 'restore' : 'maximize')
}

/**
 * Read the caption labels for the document language.
 * @returns `{ menuBar, application, edit }`.
 */
function labels() {
  const language = root()?.lang ?? 'en'
  try {
    return ipcRenderer.sendSync('dsh:caption-labels', language)
  } catch {
    return { menuBar: 'Application menu', application: 'Application', edit: 'Edit' }
  }
}

/**
 * Snapshot the field the user is typing in, carets and selection included.
 *
 * Opening a caption menu pops a native menu that can take focus away from the
 * composer; the reference shell hands the editor back after the popup closes.
 * Capturing at open time (rather than on the last `focusout`) also keeps a
 * stale field from regaining focus later.
 * @returns a callback that restores focus and selection, or a no-op.
 */
function caretSnapshot() {
  const target = document.activeElement
  if (!(target instanceof HTMLElement) || target === menuHost) return () => {}
  if (!target.matches('[contenteditable="true"], input, textarea')) return () => {}
  const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined
  const start = input?.selectionStart
  const end = input?.selectionEnd
  const direction = input?.selectionDirection
  const selection = document.getSelection()
  const ranges = input === undefined && selection !== null
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  return () => {
    if (!target.isConnected) return
    target.focus({ preventScroll: true })
    if (input !== undefined && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined)
    else if (selection !== null && ranges.length > 0) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

/** Mount the caption menubar once the Web UI has painted its shell. */
function mountMenuBar() {
  if (menuHost !== undefined && menuHost.isConnected) return
  if (document.body === null) return
  const host = document.createElement('div')
  host.dataset.windowsMenu = ''
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 1100;
        height: var(--dsh-windows-titlebar-height, 40px); display: flex; align-items: center;
        font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
        -webkit-app-region: no-drag; }
      [role=menubar] { display: flex; gap: 2px; }
      button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
        color: var(--dsw-alias-label-secondary, rgb(128, 128, 128)); font: inherit; font-size: 14px;
        cursor: default; }
      button:hover, button[aria-expanded=true] {
        background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
        color: var(--dsw-alias-label-primary, currentColor); }
      button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
        outline-offset: -2px; }
      :host-context(html[data-input-modality='pointer']) button:focus-visible { outline-color: transparent; }
    </style>
    <div role="menubar"></div>`
  const bar = shadow.querySelector('[role=menubar]')
  const text = labels()
  bar.setAttribute('aria-label', text.menuBar)
  for (const [index, name] of ['application', 'edit'].entries()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.menu = name
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.tabIndex = index === 0 ? 0 : -1
    button.textContent = text[name]
    button.addEventListener('pointerdown', (event) => { event.preventDefault() })
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-expanded') === 'true') return
      const rect = button.getBoundingClientRect()
      button.setAttribute('aria-expanded', 'true')
      const restore = caretSnapshot()
      void ipcRenderer.invoke('dsh:caption-menu', name, rect.left, rect.bottom)
        .catch((error) => { console.error('caption menu failed', error) })
        .finally(() => {
          button.setAttribute('aria-expanded', 'false')
          // Electron hands focus back to the clicked caption button on some
          // platforms; typing should continue in the composer instead.
          const active = document.activeElement
          if (active === button || active === menuHost || active === document.body) restore()
        })
    })
    button.addEventListener('keydown', (event) => {
      const buttons = [...bar.querySelectorAll('button')]
      const position = buttons.indexOf(button)
      const next = buttons[position === 0 ? 1 : 0]
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        button.tabIndex = -1
        next.tabIndex = 0
        next.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        button.click()
      }
    })
    bar.append(button)
  }
  document.body.append(host)
  menuHost = host
  host.style.display = fullscreen ? 'none' : 'flex'
}

/** Re-read localized menubar labels when the application language changes. */
function relabelMenuBar() {
  if (menuHost === undefined || !menuHost.isConnected) return
  const shadow = menuHost.shadowRoot
  const text = labels()
  shadow?.querySelector('[role=menubar]')?.setAttribute('aria-label', text.menuBar)
  shadow?.querySelector('button[data-menu=application]')?.replaceChildren(text.application)
  shadow?.querySelector('button[data-menu=edit]')?.replaceChildren(text.edit)
}

/** Reflect the native window state onto the document and the caption. */
function applyWindowState(state) {
  windowState = { maximized: state.maximized === true, fullscreen: state.fullscreen === true }
  fullscreen = windowState.fullscreen
  const element = root()
  if (element !== null) {
    if (fullscreen) element.dataset.fullscreen = 'true'
    else delete element.dataset.fullscreen
  }
  if (controlsHost !== undefined) controlsHost.style.display = fullscreen ? 'none' : 'block'
  if (menuHost !== undefined) menuHost.style.display = fullscreen ? 'none' : 'flex'
  paintMaximized(windowState.maximized)
}

/** Forward the application's theme source to Electron's native theme. */
function observeTheme() {
  const element = root()
  if (element === null) return
  let sent
  const send = () => {
    const value = element.getAttribute('data-ds-theme-source')
    if (value === null || value === sent) return
    sent = value
    ipcRenderer.send('dsh:theme', value)
  }
  new MutationObserver(send).observe(element, { attributeFilter: ['data-ds-theme-source'] })
  send()
}

/**
 * Watch for the shell overlay so the caption menubar lands on a painted frame.
 *
 * `[data-shell-overlay]` is the AppFrame's seat and appears only after the Web
 * client boots. A failure document, an older bundle, or a boot that never
 * finishes has no such seat, so a timer mounts the menubar anyway — otherwise
 * the caption would stay empty and the only menus would be unreachable.
 */
function observeShell() {
  let timer
  const mount = () => {
    if (document.querySelector('[data-shell-overlay]') === null) return
    mountMenuBar()
    clearTimeout(timer)
    observer.disconnect()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document.body, { childList: true, subtree: true })
  mount()
  timer = setTimeout(() => {
    observer.disconnect()
    mountMenuBar()
  }, MENU_MOUNT_FALLBACK_MS)
  new MutationObserver(relabelMenuBar).observe(document.documentElement, { attributeFilter: ['lang'] })
}

/**
 * Expose the optional bridges the Web UI feature-detects.
 *
 * `dshDesktop` is deliberately absent: its presence switches the Client to the
 * desktop startup flow (welcome/onboarding, native keyboard service) that only
 * the official packaged shell can complete. These two bridges are independent
 * of that flow and only upgrade file picking and dropped-file paths.
 */
function exposeBridges() {
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke('dsh:directory-pick'),
  })

  // The shell's own failure document uses this to ask main to reload the real
  // entry URL (or restart the server); it is not part of the Web client API.
  contextBridge.exposeInMainWorld('__DSH_SHELL__', {
    retry: () => ipcRenderer.invoke('dsh:retry'),
  })

  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    // A File without a real path (pasted bytes) answers '' and uploads as before.
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) ?? ''
      } catch {
        return ''
      }
    },
  })
}

/**
 * Run once a document root exists; preload can execute before it does.
 *
 * The caption marker has to land before the application's first paint, but the
 * controls and menus belong in `<body>` (that is where the design tokens live),
 * so the rest waits for the parser to finish the body.
 */
function start() {
  if (!markCaption()) {
    // The root is created by the parser moments later; retry on the next task so
    // the caption layout is in place before the application's first paint.
    setTimeout(start, 0)
    return
  }
  if (started) return
  started = true
  const ready = () => {
    mountControls()
    observeTheme()
    observeShell()
  }
  exposeBridges()
  ipcRenderer.on('dsh:window-state', (_event, state) => { applyWindowState(state) })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true })
  } else {
    ready()
  }
}

start()
