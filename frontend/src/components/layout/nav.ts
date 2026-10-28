import { CalendarDays, Cloud, LayoutGrid, RefreshCw, ScrollText, type LucideIcon } from 'lucide-react'
import type { AppStatus } from '@/api/types'

export interface NavItem {
  to: string
  /** i18n key under nav.* */
  key: 'overview' | 'icloud' | 'google' | 'sync' | 'logs'
  icon: LucideIcon
  /** Token for the colored icon tile. */
  tile: string
  /** Returns true when the section needs attention (shows a dot). */
  attention?: (status: AppStatus) => boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', key: 'overview', icon: LayoutGrid, tile: 'var(--color-tile-overview)' },
  {
    to: '/icloud',
    key: 'icloud',
    icon: Cloud,
    tile: 'var(--color-tile-icloud)',
    attention: (s) => !s.icloud.configured || s.icloud.status === 'error' || !s.source,
  },
  {
    to: '/google',
    key: 'google',
    icon: CalendarDays,
    tile: 'var(--color-tile-google)',
    attention: (s) =>
      s.google.configured_on_server && (!s.google.connected || s.google.status === 'error' || s.google.status === 'reauth_required' || !s.target),
  },
  {
    to: '/sync',
    key: 'sync',
    icon: RefreshCw,
    tile: 'var(--color-tile-sync)',
    attention: (s) => s.last_run?.message?.code === 'sync.deletion_guard_tripped',
  },
  {
    to: '/logs',
    key: 'logs',
    icon: ScrollText,
    tile: 'var(--color-tile-logs)',
    attention: (s) => s.last_run?.status === 'failed',
  },
]
