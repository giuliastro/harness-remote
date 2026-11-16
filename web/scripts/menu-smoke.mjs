/**
 * Boots Electron and installs the real application menu, then reads it back.
 *
 * The unit tests in electron/app-menu.test.mjs check the template this app produces; they cannot
 * check that Electron accepts it. That is a different class of failure and not a theoretical one:
 * an accelerator outside Electron's grammar, a `role` that a given Electron version does not have,
 * or a submenu shape it refuses all throw inside `Menu.buildFromTemplate`, which no amount of
 * asserting on our own object graph would catch.
 *
 * Runs anywhere Electron can reach a display. CI runs it on macOS, which is the platform that
 * actually installs this menu.
 *
 * Exit code 0 means the menu built and installed with the structure we asked for.
 */
import { app, Menu } from "electron"
import { buildApplicationMenu } from "../dist-electron/electron/app-menu.js"
import { parseDesktopMenuTemplate } from "../dist-electron/electron/ipc-contract.js"

// Deliberately the shape the renderer really sends, accelerators included: a checkbox item, a
// disabled item, a separator, and the comma accelerator that a stricter grammar would reject.
const TEMPLATE = [
  {
    id: "file",
    label: "File",
    items: [
      { kind: "item", command: "session.new", label: "New session", accelerator: "CmdOrCtrl+N", enabled: true },
      { kind: "item", command: "session.refresh", label: "Refresh sessions", accelerator: "CmdOrCtrl+R", enabled: false },
      { kind: "separator" },
      { kind: "item", command: "server.add", label: "Connect a server", accelerator: "CmdOrCtrl+Shift+N", enabled: true },
      { kind: "item", command: "server.settings", label: "Settings", accelerator: "CmdOrCtrl+,", enabled: true }
    ]
  },
  {
    id: "session",
    label: "Session",
    items: [{ kind: "item", command: "focus.composer", label: "Focus composer", enabled: false }]
  },
  {
    id: "view",
    label: "View",
    items: [
      { kind: "item", command: "view.palette", label: "Commands", accelerator: "CmdOrCtrl+K", enabled: true },
      { kind: "item", command: "view.inspector", label: "Toggle inspector", accelerator: "CmdOrCtrl+B", enabled: true, checked: false },
      { kind: "separator" },
      { kind: "item", command: "view.theme.dark", label: "Dark", enabled: true, checked: true }
    ]
  },
  {
    id: "help",
    label: "Help",
    items: [{ kind: "item", command: "help.open", label: "Open help", enabled: true }]
  }
]

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

// A menu is all this needs; a window would only add a surface that can fail for unrelated reasons.
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const parsed = parseDesktopMenuTemplate(TEMPLATE)
  check(parsed !== null, "the renderer's own template was rejected by the IPC validator")
  if (!parsed) return finish()

  const isMac = process.platform === "darwin"
  let installed
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu(parsed, {
      appName: "Harness Remote",
      isMac,
      onCommand: () => {}
    })))
    installed = Menu.getApplicationMenu()
  } catch (error) {
    check(false, `Electron refused the menu template: ${error instanceof Error ? error.message : String(error)}`)
    return finish()
  }

  check(Boolean(installed), "no application menu was installed")
  if (!installed) return finish()

  const labels = installed.items.map((item) => item.label)
  for (const expected of ["File", "Session", "View", "Help"]) {
    check(labels.includes(expected), `the "${expected}" menu is missing from the installed menu (got ${JSON.stringify(labels)})`)
  }
  // Electron fills these in from the role, so their exact wording is the platform's business — that
  // there are two more menus than the app supplied is what matters.
  check(installed.items.length === (isMac ? 7 : 6), `expected the app menus plus Edit and Window, got ${JSON.stringify(labels)}`)
  if (isMac) check(labels[0] === "Harness Remote", `the macOS app menu must come first and carry the app name, got ${JSON.stringify(labels[0])}`)

  const file = installed.items.find((item) => item.label === "File")?.submenu
  check(Boolean(file), "the File menu has no submenu")
  if (file) {
    const newSession = file.items[0]
    check(newSession.label === "New session", `unexpected first File item: ${newSession.label}`)
    check(newSession.accelerator === "CmdOrCtrl+N", `accelerator did not survive: ${newSession.accelerator}`)
    check(file.items[1].enabled === false, "a disabled command arrived enabled")
    check(file.items[2].type === "separator", "the separator did not survive")
    check(
      file.items.some((item) => item.accelerator === "CmdOrCtrl+,"),
      "Electron dropped the comma accelerator"
    )
  }

  const view = installed.items.find((item) => item.label === "View")?.submenu
  const dark = view?.items.find((item) => item.label === "Dark")
  check(dark?.type === "checkbox", `a checked item must install as a checkbox, got ${dark?.type}`)
  check(dark?.checked === true, "the checked state did not survive")

  finish()
})

function finish() {
  if (failures.length === 0) {
    console.log(`application menu smoke test passed on ${process.platform}`)
    // On Windows, Electron can return 1 from app.exit(0) after the menu has
    // passed every assertion. This short-lived smoke process has no window or
    // background work to tear down, so exit with the assertion result directly.
    process.exit(0)
    return
  }
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
