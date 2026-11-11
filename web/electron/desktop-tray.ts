import type { MenuItemConstructorOptions } from "electron"

export type DesktopTrayLabels = {
  open: string
  quit: string
  tooltip: string
}

/** The tray is deliberately small: show the existing window or quit the process. */
export function buildTrayMenu(
  labels: DesktopTrayLabels,
  actions: { open: () => void; quit: () => void }
): MenuItemConstructorOptions[] {
  return [
    { label: labels.open, click: actions.open },
    { type: "separator" },
    { label: labels.quit, click: actions.quit }
  ]
}

/** A close request hides the window only while the app is not quitting and a tray exists. */
export function shouldHideWindowOnClose(quitting: boolean, hasTray: boolean): boolean {
  return !quitting && hasTray
}
