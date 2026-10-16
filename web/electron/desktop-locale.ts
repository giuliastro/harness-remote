import type { MessageBoxOptions, OpenDialogOptions } from "electron"
import { createTranslator, normalizeLanguage } from "../src/i18n.js"

export function desktopTranslator(language: unknown, fallback = "en") {
  return createTranslator(normalizeLanguage(typeof language === "string" ? language : fallback))
}

export function projectFolderDialogs(language: unknown, fallback = "en"): {
  picker: OpenDialogOptions
  confirmation: MessageBoxOptions
} {
  const t = desktopTranslator(language, fallback)
  return {
    picker: {
      title: t("machine.folderPickerTitle"),
      buttonLabel: t("settings.projectFoldersAdd"),
      properties: ["openDirectory", "createDirectory"]
    },
    confirmation: {
      type: "warning",
      buttons: [t("machine.restartNow"), t("sf.cancel")],
      defaultId: 1,
      cancelId: 1,
      title: t("machine.restartTitle"),
      message: t("machine.restartMessage"),
      detail: t("machine.restartDetail")
    }
  }
}
