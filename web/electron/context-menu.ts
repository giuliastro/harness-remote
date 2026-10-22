import type { MenuItemConstructorOptions } from "electron"

/**
 * The subset of Electron's `context-menu` params the menu is built from. Declared here rather than
 * imported so the builder can be unit tested without starting an app.
 */
export type ContextMenuParams = {
  isEditable: boolean
  selectionText: string
  linkURL: string
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

/**
 * Chromium draws no context menu inside an Electron window: right-clicking a reply or the composer
 * did nothing, so the desktop app had no way to copy or paste with the mouse that the browser build
 * gets for free. This rebuilds the part of the browser's menu that applies here — edit commands in a
 * field, Copy on a selection, Copy link on a link — from `role` entries, so Electron performs the
 * action and only the label is ours.
 */
export function buildContextMenu(
  params: ContextMenuParams,
  t: (key: string) => string,
  options: { inspect?: () => void; copyLink?: (url: string) => void } = {}
): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  const items: MenuItemConstructorOptions[] = []
  const hasSelection = params.selectionText.trim().length > 0

  if (params.isEditable) {
    items.push(
      { role: "undo", label: t("ctx.undo"), enabled: flags.canUndo },
      { role: "redo", label: t("ctx.redo"), enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", label: t("ctx.cut"), enabled: flags.canCut },
      { role: "copy", label: t("ctx.copy"), enabled: flags.canCopy },
      { role: "paste", label: t("ctx.paste"), enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: t("ctx.selectAll"), enabled: flags.canSelectAll }
    )
  } else {
    if (hasSelection) items.push({ role: "copy", label: t("ctx.copy"), enabled: flags.canCopy })
    if (params.linkURL && options.copyLink) {
      const url = params.linkURL
      const copyLink = options.copyLink
      items.push({ label: t("ctx.copyLink"), click: () => copyLink(url) })
    }
    items.push({ role: "selectAll", label: t("ctx.selectAll") })
  }

  if (options.inspect) items.push({ type: "separator" }, { label: t("ctx.inspect"), click: options.inspect })
  return items
}
