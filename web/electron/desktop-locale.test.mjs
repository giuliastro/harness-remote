import assert from "node:assert/strict"
import test from "node:test"

const { desktopTranslator, networkPairingDialogs, projectFolderDialogs } = await import("../dist-electron/electron/desktop-locale.js")
const { createTranslator } = await import("../dist-electron/src/i18n.js")

test("native project-folder dialogs share the four app translations and default to Cancel", () => {
  for (const language of ["en", "it", "zh-TW", "zh-CN"]) {
    const t = createTranslator(language)
    const { picker, confirmation } = projectFolderDialogs(language)
    assert.equal(picker.title, t("machine.folderPickerTitle"))
    assert.equal(picker.buttonLabel, t("settings.projectFoldersAdd"))
    assert.deepEqual(confirmation.buttons, [t("machine.restartNow"), t("sf.cancel")])
    assert.equal(confirmation.title, t("machine.restartTitle"))
    assert.equal(confirmation.message, t("machine.restartMessage"))
    assert.equal(confirmation.detail, t("machine.restartDetail"))
    assert.equal(confirmation.defaultId, 1)
    assert.equal(confirmation.cancelId, 1)
    if (language !== "en") assert.notEqual(picker.title, projectFolderDialogs("en").picker.title)
  }
  assert.equal(desktopTranslator(undefined, "it-IT")("machine.restartNow"), createTranslator("it")("machine.restartNow"))
  assert.equal(desktopTranslator({}, "zh-CN")("machine.restartNow"), createTranslator("zh-CN")("machine.restartNow"))
})

test("the LAN pairing confirmation follows the direction of the change in all four app languages", () => {
  for (const language of ["en", "it", "zh-TW", "zh-CN"]) {
    const t = createTranslator(language)
    const enabling = networkPairingDialogs(language, "en", true).confirmation
    assert.deepEqual(enabling.buttons, [t("machine.restartNow"), t("sf.cancel")])
    assert.equal(enabling.title, t("machine.restartTitle"))
    assert.equal(enabling.message, t("machine.networkPairingConfirmMessage"))
    assert.equal(enabling.detail, t("machine.networkPairingConfirmDetail"))
    assert.equal(enabling.defaultId, 1, "a restart-triggering dialog must never default to Restart now")
    assert.equal(enabling.cancelId, 1)
    const disabling = networkPairingDialogs(language, "en", false).confirmation
    assert.equal(disabling.detail, t("machine.networkPairingConfirmDisableDetail"))
    if (language !== "en") {
      assert.notEqual(enabling.detail, networkPairingDialogs("en", "en", true).confirmation.detail)
      assert.notEqual(disabling.detail, networkPairingDialogs("en", "en", false).confirmation.detail)
    }
  }
})
