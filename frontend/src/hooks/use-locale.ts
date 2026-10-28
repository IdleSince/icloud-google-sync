import { useTranslation } from 'react-i18next'

/** Active BCP-47 locale for Intl formatters. */
export function useLocale(): string {
  const { i18n } = useTranslation()
  return i18n.resolvedLanguage ?? i18n.language
}
