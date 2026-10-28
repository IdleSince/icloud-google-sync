import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, History, ScrollText } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { api, qk } from '@/api/endpoints'
import type { LogCategory, LogEntry, LogLevel, RunStatus, RunSummary, StatsDay } from '@/api/types'
import { EmptyState } from '@/components/common/EmptyState'
import { Group, Row } from '@/components/common/Group'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryError } from '@/components/common/QueryError'
import { StatusBadge } from '@/components/common/StatusBadge'
import { RunFacts, RunItemList } from '@/components/runs/RunDetails'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Segmented } from '@/components/common/Segmented'
import { useIsSplit } from '@/hooks/use-media-query'
import { useLocale } from '@/hooks/use-locale'
import { formatDateTime, formatDayShort, formatDuration, formatNumber } from '@/lib/format'
import { tEnum, useMessage } from '@/lib/messages'
import { LOG_LEVEL_TONE, RUN_STATUS_TONE, toneOf } from '@/lib/status'
import { cn } from '@/lib/utils'

const TABS = ['history', 'errors', 'all', 'stats', 'diagnostics'] as const
type Tab = (typeof TABS)[number]
const PAGE_SIZE = 25
const LOG_LEVELS: LogLevel[] = ['info', 'warning', 'error']
const LOG_CATEGORIES: LogCategory[] = ['sync', 'icloud', 'google', 'auth', 'system']
const ALL = 'all'

/* ------------------------------------------------------------------ */

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation()
  const locale = useLocale()
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (total <= PAGE_SIZE) return null
  const from = page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" aria-label={t('pagination.label')}>
      <span className="type-footnote tabular text-text-secondary">
        {t('pagination.range', { from: formatNumber(from, locale), to: formatNumber(to, locale), total: formatNumber(total, locale) })}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden />
          {t('pagination.previous')}
        </Button>
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          {t('pagination.next')}
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  )
}

function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-1">{children}</div>
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

type RunFilter = 'all' | 'success' | 'failed'
const RUN_FILTER_STATUS: Record<RunFilter, RunStatus | undefined> = { all: undefined, success: 'success', failed: 'failed' }

function RunDetailSheet({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const { t } = useTranslation()
  const split = useIsSplit()
  const detail = useQuery({ queryKey: qk.run(runId ?? -1), queryFn: () => api.sync.run(runId!), enabled: runId !== null })
  return (
    <Sheet open={runId !== null} onOpenChange={(v) => !v && onClose()}>
      {/* Wide: side panel next to the table. Phone: bottom sheet. */}
      <SheetContent
        side={split ? 'right' : 'bottom'}
        className={cn(
          'gap-0 bg-grouped shadow-sheet',
          split ? 'w-[min(34rem,100dvw)] sm:max-w-none' : 'max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]',
        )}
      >
        <SheetHeader className="px-4 pt-5">
          <SheetTitle className="type-title">{t('runs.detail.title', { id: runId ?? '' })}</SheetTitle>
          <SheetDescription className="text-text-secondary">{t('runs.detail.description')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-(--space-section) overflow-y-auto overscroll-contain px-4 pt-2 pb-6">
          {detail.isPending ? (
            <ListSkeleton />
          ) : detail.isError ? (
            <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
          ) : (
            <>
              <Group>
                <div className="p-4">
                  <RunFacts run={detail.data} />
                </div>
              </Group>
              <Group title={t('runs.items.title')}>
                <div className="px-4">
                  <RunItemList items={detail.data.items} />
                </div>
              </Group>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CountsInline({ run }: { run: RunSummary }) {
  const { t } = useTranslation()
  const locale = useLocale()
  const part = (key: 'created' | 'updated' | 'deleted' | 'failed', cls: string) => (
    <span className={cls}>
      <span className="sr-only">{t(`runs.counts.${key}`)} </span>
      <span aria-hidden>{t(`runs.countsShort.${key}`, { value: formatNumber(run.counts[key], locale) })}</span>
    </span>
  )
  return (
    <span className="tabular inline-flex flex-wrap gap-x-3">
      {part('created', 'text-success')}
      {part('updated', 'text-accent-text')}
      {part('deleted', 'text-danger')}
      {run.counts.failed > 0 && part('failed', 'text-danger')}
    </span>
  )
}

function HistoryTab() {
  const { t } = useTranslation()
  const locale = useLocale()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<RunFilter>('all')
  const [page, setPage] = useState(0)
  // `?run=<id>` deep-links into a run's detail (from the Sync page).
  const runParam = Number(params.get('run'))
  const openRun = Number.isInteger(runParam) && runParam > 0 ? runParam : null
  const setOpenRun = (id: number | null) => {
    const next = new URLSearchParams(params)
    if (id === null) next.delete('run')
    else next.set('run', String(id))
    setParams(next, { replace: true })
  }
  const runs = useQuery({
    queryKey: qk.runs(filter, page),
    queryFn: () => api.sync.runs({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, status: RUN_FILTER_STATUS[filter] }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  })

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <Segmented
          value={filter}
          onChange={(v) => {
            setFilter(v)
            setPage(0)
          }}
          label={t('logs.history.filterLabel')}
          options={(['all', 'success', 'failed'] as const).map((f) => ({ value: f, label: t(`logs.history.filter.${f}`) }))}
        />
      </FilterBar>
      <Group>
        {runs.isPending ? (
          <ListSkeleton />
        ) : runs.isError ? (
          <div className="p-3">
            <QueryError error={runs.error} onRetry={() => void runs.refetch()} />
          </div>
        ) : runs.data.items.length === 0 ? (
          <EmptyState icon={<History aria-hidden />} title={t('logs.history.emptyTitle')} description={t('logs.history.emptyBody')} />
        ) : (
          <>
            <Table className="type-body">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 type-footnote text-text-secondary">{t('runs.columns.started')}</TableHead>
                  <TableHead className="type-footnote text-text-secondary">{t('runs.columns.status')}</TableHead>
                  <TableHead className="hidden type-footnote text-text-secondary split:table-cell">{t('runs.columns.trigger')}</TableHead>
                  <TableHead className="hidden text-right type-footnote text-text-secondary columns:table-cell">{t('runs.columns.duration')}</TableHead>
                  <TableHead className="hidden pr-4 type-footnote text-text-secondary split:table-cell">{t('runs.columns.changes')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.items.map((run) => (
                  <TableRow
                    key={run.id}
                    className="pressable cursor-pointer hover:bg-fill"
                    onClick={() => setOpenRun(run.id)}
                  >
                    <TableCell className="py-2.5 pl-4 whitespace-normal">
                      <button
                        type="button"
                        className="text-left font-medium text-text-primary tabular outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-(--color-focus-ring)"
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenRun(run.id)
                        }}
                        aria-label={t('runs.openDetail', { date: formatDateTime(run.started_at, locale) })}
                      >
                        {formatDateTime(run.started_at, locale)}
                      </button>
                      <div className="type-footnote mt-0.5 text-text-secondary split:hidden">
                        <CountsInline run={run} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        <StatusBadge tone={toneOf(RUN_STATUS_TONE, run.status)}>{tEnum(t, 'runs.status', run.status)}</StatusBadge>
                        {run.dry_run && <StatusBadge tone="warning">{t('runs.dryRunBadge')}</StatusBadge>}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-text-secondary split:table-cell">{tEnum(t, 'runs.trigger', run.trigger)}</TableCell>
                    <TableCell className="hidden text-right tabular text-text-secondary columns:table-cell">
                      {run.duration_ms !== null ? formatDuration(run.duration_ms, locale) : ''}
                    </TableCell>
                    <TableCell className="hidden pr-4 split:table-cell">
                      <CountsInline run={run} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination page={page} total={runs.data.total} onPage={setPage} />
          </>
        )}
      </Group>
      <RunDetailSheet runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

function LogList({ items }: { items: LogEntry[] }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const locale = useLocale()
  return (
    <ul className="flex flex-col">
      {items.map((entry) => (
        <li key={entry.id} className="group-row relative flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
            <span className="text-text-primary">{msg(entry.code, entry.params)}</span>
            <span className="type-footnote font-mono break-all text-text-tertiary">{entry.code}</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <StatusBadge tone={toneOf(LOG_LEVEL_TONE, entry.level)}>{tEnum(t, 'logs.level', entry.level)}</StatusBadge>
            <StatusBadge tone="neutral">{tEnum(t, 'logs.category', entry.category)}</StatusBadge>
            <time dateTime={entry.ts} className="type-footnote tabular text-text-secondary">
              {formatDateTime(entry.ts, locale, { seconds: true })}
            </time>
          </div>
        </li>
      ))}
    </ul>
  )
}

function LogsTab({ fixedLevel }: { fixedLevel?: LogLevel }) {
  const { t } = useTranslation()
  const [level, setLevel] = useState<string>(fixedLevel ?? ALL)
  const [category, setCategory] = useState<string>(ALL)
  const [page, setPage] = useState(0)
  const effectiveLevel = (fixedLevel ?? (level === ALL ? undefined : level)) as LogLevel | undefined
  const effectiveCategory = category === ALL ? undefined : (category as LogCategory)
  const logs = useQuery({
    queryKey: qk.logs(effectiveLevel ?? ALL, category, page),
    queryFn: () => api.logs({ level: effectiveLevel, category: effectiveCategory, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  })

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        {!fixedLevel && (
          <Select
            value={level}
            onValueChange={(v) => {
              setLevel(v)
              setPage(0)
            }}
          >
            <SelectTrigger aria-label={t('logs.filter.level')} className="h-9 min-w-36 bg-surface pointer-coarse:h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="shadow-popover">
              <SelectItem value={ALL}>{t('logs.filter.allLevels')}</SelectItem>
              {LOG_LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {tEnum(t, 'logs.level', l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          value={category}
          onValueChange={(v) => {
            setCategory(v)
            setPage(0)
          }}
        >
          <SelectTrigger aria-label={t('logs.filter.category')} className="h-9 min-w-36 bg-surface pointer-coarse:h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="shadow-popover">
            <SelectItem value={ALL}>{t('logs.filter.allCategories')}</SelectItem>
            {LOG_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {tEnum(t, 'logs.category', c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>
      <Group>
        {logs.isPending ? (
          <ListSkeleton />
        ) : logs.isError ? (
          <div className="p-3">
            <QueryError error={logs.error} onRetry={() => void logs.refetch()} />
          </div>
        ) : logs.data.items.length === 0 ? (
          fixedLevel === 'error' ? (
            <EmptyState icon={<CircleCheck aria-hidden />} title={t('logs.errors.emptyTitle')} description={t('logs.errors.emptyBody')} />
          ) : (
            <EmptyState icon={<ScrollText aria-hidden />} title={t('logs.all.emptyTitle')} description={t('logs.all.emptyBody')} />
          )
        ) : (
          <>
            <LogList items={logs.data.items} />
            <Pagination page={page} total={logs.data.total} onPage={setPage} />
          </>
        )}
      </Group>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Stats — plain HTML table with CSS bars, no chart library            */
/* ------------------------------------------------------------------ */

const STAT_RANGES = [7, 30, 90] as const

function StatsTab() {
  const { t } = useTranslation()
  const locale = useLocale()
  const [days, setDays] = useState<number>(30)
  const stats = useQuery({ queryKey: qk.stats(days), queryFn: () => api.stats(days), placeholderData: keepPreviousData })

  const rows: StatsDay[] = stats.data ? [...stats.data.days].reverse() : []
  const totals = rows.reduce(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      failed: acc.failed + d.failed_runs,
      created: acc.created + d.created,
      updated: acc.updated + d.updated,
      deleted: acc.deleted + d.deleted,
    }),
    { runs: 0, failed: 0, created: 0, updated: 0, deleted: 0 },
  )
  const max = Math.max(1, ...rows.map((d) => d.created + d.updated + d.deleted))
  const pct = (n: number) => `${(n / max) * 100}%`

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <Segmented
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          label={t('logs.stats.rangeLabel')}
          options={STAT_RANGES.map((d) => ({ value: String(d), label: t('logs.stats.range', { count: d }) }))}
        />
      </FilterBar>

      {stats.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : stats.isError ? (
        <QueryError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 split:grid-cols-5">
            {(
              [
                ['runs', totals.runs, ''],
                ['failed', totals.failed, 'text-danger'],
                ['created', totals.created, 'text-success'],
                ['updated', totals.updated, 'text-accent-text'],
                ['deleted', totals.deleted, 'text-danger'],
              ] as const
            ).map(([key, value, cls]) => (
              <div key={key} className="flex flex-col gap-1 rounded-xl bg-surface p-4 shadow-card">
                <span className={cn('type-metric', cls)}>{formatNumber(value, locale)}</span>
                <span className="type-footnote text-text-secondary">{t(`logs.stats.totals.${key}`)}</span>
              </div>
            ))}
          </div>

          <Group title={t('logs.stats.perDay')}>
            <div className="type-footnote flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-text-secondary" aria-hidden>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-(--color-chart-created)" />
                {t('runs.counts.created')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-(--color-chart-updated)" />
                {t('runs.counts.updated')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-(--color-chart-deleted)" />
                {t('runs.counts.deleted')}
              </span>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={<History aria-hidden />} title={t('logs.stats.emptyTitle')} description={t('logs.stats.emptyBody')} />
            ) : (
              <Table className="type-body">
                <caption className="sr-only">{t('logs.stats.caption', { count: days })}</caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4 type-footnote text-text-secondary">{t('logs.stats.columns.date')}</TableHead>
                    <TableHead className="w-full type-footnote text-text-secondary">
                      <span className="sr-only split:not-sr-only">{t('logs.stats.columns.changes')}</span>
                    </TableHead>
                    <TableHead className="text-right type-footnote text-text-secondary">{t('runs.counts.created')}</TableHead>
                    <TableHead className="text-right type-footnote text-text-secondary">{t('runs.counts.updated')}</TableHead>
                    <TableHead className="text-right type-footnote text-text-secondary">{t('runs.counts.deleted')}</TableHead>
                    <TableHead className="hidden pr-4 text-right type-footnote text-text-secondary split:table-cell">
                      {t('logs.stats.columns.runs')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.date} className="hover:bg-fill">
                      <TableCell className="py-2 pl-4 tabular text-text-secondary">
                        <time dateTime={d.date}>{formatDayShort(d.date, locale)}</time>
                      </TableCell>
                      <TableCell className="min-w-16 py-2" aria-hidden>
                        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-(--color-chart-track)">
                          <span className="h-full bg-(--color-chart-created)" style={{ width: pct(d.created) }} />
                          <span className="h-full bg-(--color-chart-updated)" style={{ width: pct(d.updated) }} />
                          <span className="h-full bg-(--color-chart-deleted)" style={{ width: pct(d.deleted) }} />
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right tabular">{formatNumber(d.created, locale)}</TableCell>
                      <TableCell className="py-2 text-right tabular">{formatNumber(d.updated, locale)}</TableCell>
                      <TableCell className="py-2 text-right tabular">{formatNumber(d.deleted, locale)}</TableCell>
                      <TableCell className="hidden py-2 pr-4 text-right tabular text-text-secondary split:table-cell">
                        {formatNumber(d.runs, locale)}
                        {d.failed_runs > 0 && <span className="ml-1 text-danger">{t('logs.stats.failedShort', { count: d.failed_runs })}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Group>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Technical diagnostics                                               */
/* ------------------------------------------------------------------ */

function Bool({ ok }: { ok: boolean }) {
  const { t } = useTranslation()
  return ok ? (
    <span className="inline-flex items-center gap-1.5 text-success">
      <CircleCheck className="size-4" aria-hidden />
      {t('common.yes')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-danger">
      <CircleX className="size-4" aria-hidden />
      {t('common.no')}
    </span>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono type-footnote break-all text-text-primary">{children}</span>
}

function DiagnosticsTab() {
  const { t } = useTranslation()
  const locale = useLocale()
  const diag = useQuery({ queryKey: qk.diagnostics, queryFn: api.diagnostics })
  if (diag.isPending) return <Skeleton className="h-80 rounded-xl" />
  if (diag.isError) return <QueryError error={diag.error} onRetry={() => void diag.refetch()} />
  const d = diag.data
  return (
    <div className="grid items-start gap-(--space-section) columns:grid-cols-2 columns:gap-x-6">
      <Group title={t('logs.diagnostics.app')}>
        <Row label={t('logs.diagnostics.appVersion')}>
          <Mono>{d.app_version}</Mono>
        </Row>
        <Row label={t('logs.diagnostics.pythonVersion')}>
          <Mono>{d.python_version}</Mono>
        </Row>
        <Row label={t('logs.diagnostics.baseUrl')}>
          <Mono>{d.base_url}</Mono>
        </Row>
        <Row label={t('logs.diagnostics.redirectUri')} description={t('logs.diagnostics.redirectUriHint')}>
          <Mono>{d.redirect_uri}</Mono>
        </Row>
        <Row label={t('logs.diagnostics.serverTime')}>
          <span className="tabular text-text-primary">{formatDateTime(d.server_time, locale, { seconds: true })}</span>
        </Row>
        <Row label={t('logs.diagnostics.secureCookies')}>
          <Bool ok={d.secure_cookies} />
        </Row>
      </Group>
      <div className="flex flex-col gap-(--space-section)">
        <Group title={t('logs.diagnostics.database')}>
          <Row label={t('logs.diagnostics.databaseOk')}>
            <Bool ok={d.database.ok} />
          </Row>
          <Row label={t('logs.diagnostics.migration')}>
            <Mono>{d.database.migration ?? t('common.none')}</Mono>
          </Row>
        </Group>
        <Group title={t('logs.diagnostics.scheduler')}>
          <Row label={t('logs.diagnostics.schedulerRunning')}>
            <Bool ok={d.scheduler.running} />
          </Row>
          <Row label={t('logs.diagnostics.nextRun')}>
            <span className="tabular text-text-primary">{d.scheduler.next_run_at ? formatDateTime(d.scheduler.next_run_at, locale, { seconds: true }) : t('common.none')}</span>
          </Row>
          <Row label={t('logs.diagnostics.jobCount')}>
            <span className="tabular text-text-primary">{formatNumber(d.scheduler.job_count, locale)}</span>
          </Row>
        </Group>
        <Group title={t('logs.diagnostics.secrets')} footer={t('logs.diagnostics.secretsFooter')}>
          <Row label={t('logs.diagnostics.encryptionKey')}>
            <Bool ok={d.secrets.encryption_key} />
          </Row>
          <Row label={t('logs.diagnostics.googleClient')}>
            <Bool ok={d.secrets.google_client} />
          </Row>
          <Row label={t('logs.diagnostics.adminPassword')}>
            <Bool ok={d.secrets.admin_password} />
          </Row>
        </Group>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v)
}

export function LogsPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = isTab(raw) ? raw : 'history'

  return (
    <>
      <PageHeader title={t('logs.title')} description={t('logs.description')} />
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'history' ? {} : { tab: v }, { replace: true })} className="mt-4 gap-4">
        {/* Scrolls horizontally on phones instead of squeezing five labels. */}
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] split:mx-0 split:px-0">
          <TabsList className="h-auto bg-fill p-0.5 group-data-horizontal/tabs:h-auto">
            {TABS.map((key) => (
              <TabsTrigger key={key} value={key} className="px-3 py-1.5 whitespace-nowrap pointer-coarse:min-h-10">
                {t(`logs.tabs.${key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>
        <TabsContent value="errors">
          <LogsTab key="errors" fixedLevel="error" />
        </TabsContent>
        <TabsContent value="all">
          <LogsTab key="all" />
        </TabsContent>
        <TabsContent value="stats">
          <StatsTab />
        </TabsContent>
        <TabsContent value="diagnostics">
          <DiagnosticsTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
