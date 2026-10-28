import { ChevronUp, CircleUserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router'
import { useSession, useStatus } from '@/api/hooks'
import type { AppStatus } from '@/api/types'
import { cn } from '@/lib/utils'
import { NAV_ITEMS, type NavItem } from './nav'
import { PreferencesSheet } from './PreferencesSheet'

function AttentionDot({ label }: { label: string }) {
  return (
    <span className="relative flex size-2.5 shrink-0">
      <span aria-hidden className="size-2.5 rounded-full bg-danger" />
      <span className="sr-only">{label}</span>
    </span>
  )
}

function needsAttention(item: NavItem, status: AppStatus | undefined): boolean {
  return Boolean(status && item.attention?.(status))
}

/** Wide arrangement: Apple-System-Settings sidebar with colored icon tiles. */
function Sidebar({ status }: { status: AppStatus | undefined }) {
  const { t } = useTranslation()
  const session = useSession()
  return (
    <aside
      className="material-chrome sticky top-0 hidden h-dvh flex-col border-r border-separator split:flex"
      aria-label={t('nav.label')}
    >
      <div className="flex flex-col gap-0.5 px-5 pt-8 pb-5">
        <span className="type-headline">{t('app.name')}</span>
        <span className="type-footnote text-text-secondary">{t('app.tagline')}</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label={t('nav.label')}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'pressable flex min-h-(--size-row-min-fine) items-center gap-3 rounded-lg px-2 py-1.5 type-body text-text-primary no-underline outline-none hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-(--color-focus-ring) pointer-coarse:min-h-(--size-row-min)',
                  isActive && 'bg-fill-strong font-medium hover:bg-fill-strong',
                )
              }
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-tile) text-tile-glyph"
                style={{ backgroundColor: item.tile }}
              >
                <Icon className="size-4" strokeWidth={2.25} />
              </span>
              <span className="min-w-0 flex-1">{t(`nav.${item.key}`)}</span>
              {needsAttention(item, status) && <AttentionDot label={t('nav.attention')} />}
            </NavLink>
          )
        })}
      </nav>
      <div className="border-t border-separator p-3">
        <PreferencesSheet
          trigger={
            <button
              type="button"
              className="pressable flex w-full min-h-(--size-row-min) items-center gap-3 rounded-lg px-2 text-left hover:bg-fill"
              aria-label={t('preferences.open')}
            >
              <CircleUserRound className="size-7 shrink-0 text-text-secondary" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate type-body font-medium">{session.data?.username ?? ''}</span>
                <span className="type-footnote text-text-secondary">{t('preferences.title')}</span>
              </span>
              <ChevronUp className="size-4 text-text-tertiary" aria-hidden />
            </button>
          }
        />
      </div>
    </aside>
  )
}

/** Compact arrangement: bottom tab bar. Five top-level sections = iOS tab bar limit,
 *  and the dashboard stays one tap away from anywhere (better than drill-down for a
 *  status app that is checked often). */
function TabBar({ status }: { status: AppStatus | undefined }) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('nav.label')}
      className="material-chrome fixed inset-x-0 bottom-0 z-40 border-t border-separator pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] split:hidden"
    >
      <ul className="grid h-(--size-tabbar) grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.key} className="flex">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'relative flex flex-1 flex-col items-center justify-center gap-0.5 px-0.5 type-tab leading-tight font-medium tracking-(--tracking-small) no-underline outline-none focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-focus-ring)',
                    isActive ? 'text-accent-text' : 'text-text-secondary',
                  )
                }
              >
                <span className="relative">
                  <Icon className="size-6" aria-hidden />
                  {needsAttention(item, status) && (
                    <span className="absolute -top-0.5 -right-1">
                      <AttentionDot label={t('nav.attention')} />
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{t(`nav.${item.key}`)}</span>
              </NavLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function AppShell() {
  const status = useStatus()
  const { t } = useTranslation()
  return (
    <div className="min-h-dvh split:grid split:grid-cols-[var(--size-sidebar)_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface-raised px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('nav.skipToContent')}
      </a>
      <Sidebar status={status.data} />
      <main
        id="main"
        tabIndex={-1}
        className="safe-x min-w-0 pb-[calc(var(--size-tabbar)+env(safe-area-inset-bottom)+2rem)] outline-none split:pb-12"
      >
        <Outlet />
      </main>
      <TabBar status={status.data} />
    </div>
  )
}
