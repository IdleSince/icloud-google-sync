import type { ThemePreference } from './theme-context'

export const THEME_STORAGE_KEY = 'icgs.theme'

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* storage blocked (private mode) — fall back to the system setting */
  }
  return 'system'
}

export function writeThemePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    /* ignore */
  }
}

/** Applies the preference to <html>. `system` removes the attribute so the
 *  prefers-color-scheme media query in tokens.css takes over. */
export function applyThemePreference(value: ThemePreference): void {
  const root = document.documentElement
  if (value === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', value)

  // Keep the browser chrome (theme-color) in step with a forced theme.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.dataset.scheme
    if (!scheme) continue
    if (value === 'system') meta.media = `(prefers-color-scheme: ${scheme})`
    else meta.media = scheme === value ? 'all' : 'not all'
  }
}
