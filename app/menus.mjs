/**
 * Native menu templates for the shell.
 *
 * The caption menubar is drawn by the preload (it has to share the 40px window
 * caption with the Web UI), but the popups it opens are real Electron menus
 * built here, exactly like the reference desktop shell does.
 */

import { resolveDesktopLocale } from './locale.mjs'

/**
 * Labels the caption menubar needs for a document language.
 * @param language - the document's `lang` attribute.
 * @returns localized menubar, Application and Edit labels.
 */
export function captionLabels(language) {
  const { messages } = resolveDesktopLocale(language)
  return { menuBar: messages.menuBar, application: messages.application, edit: messages.edit }
}

/**
 * Build the Application popup.
 * @param messages - desktop messages for the active language.
 * @param actions - shell callbacks for the items the shell owns.
 * @returns items for `Menu.buildFromTemplate`.
 */
export function applicationTemplate(messages, actions) {
  return [
    { label: messages.aboutMenu, click: () => { actions.about() } },
    { type: 'separator' },
    { label: messages.checkUpdatesMenu, click: () => { actions.checkUpdates() } },
    { type: 'separator' },
    // A stuck Web client has no browser reload; the caption menu is the only
    // way back, so the item is always present (the reference shell shows it in
    // development builds only).
    { label: messages.reloadPageMenu, accelerator: 'CmdOrCtrl+R', click: () => { actions.reload() } },
    { type: 'separator' },
    { label: messages.toggleDevToolsMenu, role: 'toggleDevTools' },
    { type: 'separator' },
    { label: messages.exitApplication, role: 'quit' },
  ]
}

/**
 * Build the Edit popup. Roles target the focused WebContents, so they act on
 * the composer or whichever field owns the caret.
 * @param messages - desktop messages for the active language.
 * @returns items for `Menu.buildFromTemplate`.
 */
export function editTemplate(messages) {
  return [
    { label: messages.undo, role: 'undo' },
    { label: messages.redo, role: 'redo' },
    { type: 'separator' },
    { label: messages.cut, role: 'cut' },
    { label: messages.copy, role: 'copy' },
    { label: messages.paste, role: 'paste' },
    { label: messages.delete, role: 'delete' },
    { type: 'separator' },
    { label: messages.selectAll, role: 'selectAll' },
  ]
}

/**
 * Build a context menu for a right click inside the page.
 * @param messages - desktop messages for the active language.
 * @param flags - Electron's edit flags for the click target.
 * @param selectionText - the clicked selection, if any.
 * @returns items for `Menu.buildFromTemplate`, possibly empty.
 */
export function contextTemplate(messages, flags, selectionText) {
  const items = []
  if (flags.isEditable === true) {
    items.push(
      { label: messages.undo, role: 'undo', enabled: flags.canUndo },
      { label: messages.redo, role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { label: messages.cut, role: 'cut', enabled: flags.canCut },
      { label: messages.copy, role: 'copy', enabled: flags.canCopy },
      { label: messages.paste, role: 'paste', enabled: flags.canPaste },
      { type: 'separator' },
      { label: messages.selectAll, role: 'selectAll', enabled: flags.canSelectAll },
    )
  } else if (selectionText.length > 0) {
    items.push({ label: messages.copy, role: 'copy', enabled: flags.canCopy })
  }
  // The reference menu drops Electron's automatic accelerator labels; the keys
  // already work, and a bare "Ctrl+Z" next to every item is visual noise.
  return items.map((item) => (item.role === undefined ? item : { ...item, accelerator: '' }))
}
