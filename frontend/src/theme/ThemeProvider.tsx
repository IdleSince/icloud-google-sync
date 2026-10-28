import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ThemeContext, type ThemePreference } from './theme-context'
import { applyThemePreference, readThemePreference, writeThemePreference } from './theme-storage'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setState] = useState<ThemePreference>(readThemePreference)

  const setPreference = useCallback((value: ThemePreference) => {
    setState(value)
    writeThemePreference(value)
    applyThemePreference(value)
  }, [])

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
