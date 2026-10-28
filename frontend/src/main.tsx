import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/i18n'
import { applyThemePreference, readThemePreference } from '@/theme/theme-storage'
import App from './App'

// Apply a forced theme before the first render to avoid a light/dark flash.
applyThemePreference(readThemePreference())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
