import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from '@/locales/de.json'
import en from '@/locales/en.json'

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'de'
export const LANGUAGE_STORAGE_KEY = 'icgs.language'

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/** Stored choice first, then the browser's preferred languages, then German. */
export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isLanguage(stored)) return stored
  } catch {
    /* storage blocked */
  }
  const candidates = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : []
  for (const candidate of candidates) {
    const base = candidate?.toLowerCase().split('-')[0]
    if (isLanguage(base)) return base
  }
  return DEFAULT_LANGUAGE
}

export function persistLanguage(lang: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch {
    /* ignore */
  }
}

function syncDocument(lang: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
  document.title = i18n.t('app.documentTitle')
}

void i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false }, // React escapes already
  returnNull: false,
})

syncDocument(i18n.language)
i18n.on('languageChanged', syncDocument)

export default i18n
