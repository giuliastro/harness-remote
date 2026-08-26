import { useEffect, useMemo, useState } from "react"
import { APP_PREFERENCES_CHANGED_EVENT, loadLanguage } from "./appPreferences"
import { createTranslator, type LanguageCode, type Translator } from "./i18n"

/**
 * The language a shell should render in, following the preference live.
 *
 * `persistLanguage` already fires `APP_PREFERENCES_CHANGED_EVENT`, but nothing in the Session-first
 * shell listened: the Settings picker offered four languages and only the page it lived on used
 * them, so choosing a language changed a handful of labels and left the product in English. A
 * component that reads the language through this hook re-renders on the same event, so one choice
 * reaches every mounted surface without a reload.
 */
export function useLanguage(): LanguageCode {
  const [language, setLanguage] = useState<LanguageCode>(loadLanguage)

  useEffect(() => {
    const follow = () => setLanguage(loadLanguage())
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, follow)
    // A second tab or window writing the preference reaches this one only through `storage`.
    window.addEventListener("storage", follow)
    return () => {
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, follow)
      window.removeEventListener("storage", follow)
    }
  }, [])

  return language
}

/** The translator for the current language, stable until the language actually changes. */
export function useTranslator(): Translator {
  const language = useLanguage()
  return useMemo(() => createTranslator(language), [language])
}
