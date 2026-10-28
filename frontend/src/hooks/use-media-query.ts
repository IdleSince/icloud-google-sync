import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Width at which the sidebar (16.5rem) and a readable content pane fit side by side. */
export const SPLIT_QUERY = '(min-width: 48rem)'

export function useIsSplit(): boolean {
  return useMediaQuery(SPLIT_QUERY)
}
