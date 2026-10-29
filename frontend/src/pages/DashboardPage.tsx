import { ArrowRight, CalendarX2, CheckCircle2, ChevronRight, Circle, CircleAlert, CircleCheck, Pause, RefreshCw } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useSetPairEnabled, useStartRun, useStatus } from '@/api/hooks'
import type { AppStatus, Pair } from '@/api/types'
import { EmptyState } from '@/components/common/EmptyState'
import { Metric } from '@/components/common/Metric'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryError } from '@/components/common/QueryError'
import { RelativeTime } from '@/components/common/RelativeTime'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale } from '@/hooks/use-locale'
import { displayOwner, formatDateTime, formatNumber } from '@/lib/format'
import { tEnum, useMessage } from '@/lib/messages'
import { canSync as anyPairSyncable, everyEnabledPairHasTarget, isSyncable } from '@/lib/pairs'
import { GOOGLE_TONE, ICLOUD_TONE, RUN_STATUS_TONE, toneOf } from '@/lib/status'
import { cn } from '@/lib/utils'

function Panel({ title, description, action, children, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('min-w-0 gap-4 rounded-xl bg-surface py-5 shadow-card ring-0', className)}>
      <CardHeader className="px-5">
        <CardTitle className="type-headline">{title}</CardTitle>
        {description && <CardDescription className="type-footnote text-text-secondary">{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5">{children}</CardContent>
    </Card>
  )
}

function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-right break-words text-text-primary">{children}</dd>
    </div>
  )
}

function SetupChecklist({ status }: { status: AppStatus }) {
  const { t } = useTranslation()
  const steps = [
    { done: status.icloud.configured, label: t('dashboard.setup.icloud'), to: '/icloud' },
    { done: status.pairs.length > 0, label: t('dashboard.setup.pairs'), to: '/icloud' },
    { done: status.google.connected, label: t('dashboard.setup.google'), to: '/google' },
    { done: everyEnabledPairHasTarget(status.pairs), label: t('dashboard.setup.targets'), to: '/google' },
    { done: status.sync.enabled, label: t('dashboard.setup.enable'), to: '/sync' },
  ]
  if (steps.every((s) => s.done)) return null
  return (
    <Panel title={t('dashboard.setup.title')} description={t('dashboard.setup.description')} className="split:col-span-2 columns:col-span-3">
      <ol className="flex flex-col">
        {steps.map((step) => (
          <li key={step.label}>
            <Link
              to={step.to}
              className="pressable -mx-2 flex min-h-(--size-row-min) items-center gap-3 rounded-lg px-2 text-text-primary no-underline hover:bg-fill"
            >
              {step.done ? (
                <CheckCircle2 className="size-5 text-success" aria-hidden />
              ) : (
                <Circle className="size-5 text-text-tertiary" aria-hidden />
              )}
              <span className={cn('flex-1', step.done && 'text-text-secondary line-through')}>{step.label}</span>
              <span className="sr-only">{step.done ? t('dashboard.setup.done') : t('dashboard.setup.open')}</span>
              <ChevronRight className="size-4 text-text-tertiary" aria-hidden />
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

/** One synced calendar. Phone: stacked. Wide: source | target | numbers | controls side by side. */
function PairRow({ pair, running }: { pair: Pair; running: boolean }) {
  const { t } = useTranslation()
  const switchId = useId()
  const setEnabled = useSetPairEnabled()
  const startRun = useStartRun()
  const run = pair.last_run
  const togglePending = setEnabled.isPending && setEnabled.variables?.pair.id === pair.id
  const runPending = startRun.isPending && startRun.variables?.pair?.id === pair.id
  return (
    <li className="group-row relative grid gap-x-6 gap-y-2 py-3 columns:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,14rem)_auto] columns:items-center">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-words text-text-primary">{pair.source.name}</span>
          {pair.source.shared && <StatusBadge tone="accent">{t('calendar.badge.shared')}</StatusBadge>}
          {!pair.enabled && <StatusBadge tone="neutral">{t('pairs.pausedBadge')}</StatusBadge>}
        </div>
        {pair.source.owner && <span className="type-footnote break-all text-text-secondary">{t('calendar.ownerValue', { owner: displayOwner(pair.source.owner) })}</span>}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ArrowRight className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        <span className="sr-only">{t('pairs.to')}</span>
        {pair.target ? (
          <>
            <span className="min-w-0 break-words text-text-primary">{pair.target.name}</span>
            {pair.target.is_primary && <StatusBadge tone="warning">{t('calendar.badge.primary')}</StatusBadge>}
          </>
        ) : (
          <Link to="/google" className="pressable rounded-sm text-warning underline underline-offset-2">
            {t('pairs.assignTarget')}
          </Link>
        )}
      </div>

      <div className="type-footnote flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-text-secondary">
        {run && <StatusBadge tone={toneOf(RUN_STATUS_TONE, run.status)}>{tEnum(t, 'runs.status', run.status)}</StatusBadge>}
        <span className="tabular">{t('pairs.mapped', { count: pair.mapped_events })}</span>
        <span>
          {pair.last_success_at ? (
            <Trans i18nKey="pairs.lastSuccessAt" components={{ time: <RelativeTime value={pair.last_success_at} /> }} />
          ) : (
            t('pairs.neverSucceeded')
          )}
        </span>
      </div>

      <div className="flex items-center gap-1 columns:justify-end">
        <Switch
          id={switchId}
          checked={pair.enabled}
          disabled={togglePending}
          aria-label={t('pairs.toggle', { name: pair.source.name })}
          onCheckedChange={(enabled) => setEnabled.mutate({ pair, enabled })}
        />
        <Button
          variant="ghost"
          size="icon-lg"
          className="text-accent-text pointer-coarse:size-11"
          disabled={running || startRun.isPending || !isSyncable(pair)}
          aria-label={t('pairs.syncOne', { name: pair.source.name })}
          title={t('pairs.syncOne', { name: pair.source.name })}
          onClick={() => startRun.mutate({ dryRun: false, pair })}
        >
          {runPending ? <Spinner /> : <RefreshCw aria-hidden />}
        </Button>
      </div>
    </li>
  )
}

function PairsPanel({ status }: { status: AppStatus }) {
  const { t } = useTranslation()
  const running = status.sync.running
  return (
    <Panel
      title={t('pairs.title')}
      description={status.pairs.length > 0 ? t('pairs.footer') : undefined}
      className="split:col-span-2 columns:col-span-3"
      action={
        <Button asChild variant="ghost" size="sm" className="text-accent-text">
          <Link to="/icloud">{t('pairs.emptyAction')}</Link>
        </Button>
      }
    >
      {status.pairs.length === 0 ? (
        <EmptyState icon={<CalendarX2 aria-hidden />} title={t('pairs.emptyTitle')} description={t('pairs.emptyBody')} />
      ) : (
        <ul className="flex flex-col" aria-label={t('pairs.title')}>
          {status.pairs.map((pair) => (
            <PairRow key={pair.id} pair={pair} running={running} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-5 split:grid-cols-2 columns:grid-cols-3" aria-hidden>
      <Skeleton className="h-40 rounded-xl split:col-span-2 columns:col-span-3" />
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  )
}

export function DashboardPage() {
  const { t } = useTranslation()
  const msg = useMessage()
  const locale = useLocale()
  const status = useStatus()
  const startRun = useStartRun()

  const data = status.data
  const running = data?.sync.running ?? false
  const canSync = anyPairSyncable(data?.pairs ?? [])
  const pairNames = new Map((data?.pairs ?? []).map((p) => [p.id, p.source.name]))

  const syncButton = (
    <Button
      size="lg"
      className="h-10 px-4 pointer-coarse:h-11"
      disabled={!data || running || startRun.isPending || !canSync}
      onClick={() => startRun.mutate({ dryRun: false })}
    >
      {running || startRun.isPending ? <Spinner /> : <RefreshCw aria-hidden />}
      {running ? t('dashboard.sync.running') : t('actions.syncNow')}
    </Button>
  )

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.description')} />
      <div className="mt-4 flex flex-col gap-5">
        {status.isPending && <DashboardSkeleton />}
        {status.isError && <QueryError error={status.error} onRetry={() => void status.refetch()} />}
        {data && (
          <div className="grid gap-5 split:grid-cols-2 columns:grid-cols-3">
            <SetupChecklist status={data} />

            {/* Sync hero: spans the full row, actions beside the state on wide screens. */}
            <Card className="min-w-0 rounded-xl bg-surface py-5 shadow-card ring-0 split:col-span-2 columns:col-span-3">
              <CardContent className="flex flex-col gap-5 px-5 columns:flex-row columns:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-11 shrink-0 items-center justify-center rounded-full',
                      running ? 'bg-accent-soft text-accent-text' : data.sync.enabled ? 'bg-success-soft text-success' : 'bg-fill text-text-secondary',
                    )}
                  >
                    {running ? <Spinner className="size-5" /> : data.sync.enabled ? <CircleCheck className="size-5" /> : <Pause className="size-5" />}
                  </span>
                  <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
                    <h2 className="type-title">
                      {running ? t('dashboard.sync.running') : data.sync.enabled ? t('dashboard.sync.active') : t('dashboard.sync.paused')}
                    </h2>
                    <p className="text-text-secondary">
                      {data.sync.enabled
                        ? t('dashboard.sync.interval', { count: data.sync.interval_minutes })
                        : t('dashboard.sync.pausedHint')}
                    </p>
                  </div>
                </div>
                <dl className="grid min-w-0 gap-x-8 gap-y-3 sm:grid-cols-2 columns:flex-[1.2]">
                  <div className="flex flex-col gap-0.5">
                    <dt className="type-footnote text-text-secondary">{t('dashboard.sync.lastSuccess')}</dt>
                    <dd className="type-headline">
                      {data.sync.last_success_at ? <RelativeTime value={data.sync.last_success_at} /> : t('dashboard.sync.never')}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="type-footnote text-text-secondary">{t('dashboard.sync.nextRun')}</dt>
                    <dd className="type-headline">
                      {running
                        ? t('dashboard.sync.inProgress')
                        : data.sync.enabled && data.sync.next_run_at
                          ? <RelativeTime value={data.sync.next_run_at} />
                          : t('dashboard.sync.notScheduled')}
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-2 columns:items-end">
                  {syncButton}
                  {!canSync && <p className="type-footnote text-text-secondary">{t('dashboard.sync.notConfigured')}</p>}
                </div>
              </CardContent>
            </Card>

            <PairsPanel status={data} />

            <Panel
              title={t('dashboard.icloud.title')}
              action={
                <StatusBadge tone={data.icloud.configured ? toneOf(ICLOUD_TONE, data.icloud.status) : 'neutral'}>
                  {data.icloud.configured ? tEnum(t, 'status.icloud', data.icloud.status) : t('status.notConfigured')}
                </StatusBadge>
              }
            >
              <dl className="flex flex-col gap-2.5">
                <KeyValue label={t('dashboard.icloud.account')}>{data.icloud.account_masked ?? t('common.none')}</KeyValue>
                {data.icloud.last_checked_at && (
                  <KeyValue label={t('dashboard.lastChecked')}>
                    <RelativeTime value={data.icloud.last_checked_at} live={false} />
                  </KeyValue>
                )}
              </dl>
              {data.icloud.error && <p className="type-footnote text-danger">{msg(data.icloud.error)}</p>}
              <Button asChild variant="outline" className="self-start">
                <Link to="/icloud">{t('dashboard.icloud.manage')}</Link>
              </Button>
            </Panel>

            <Panel
              title={t('dashboard.google.title')}
              action={
                <StatusBadge tone={data.google.connected ? toneOf(GOOGLE_TONE, data.google.status) : 'neutral'}>
                  {data.google.connected ? tEnum(t, 'status.google', data.google.status) : t('status.notConnected')}
                </StatusBadge>
              }
            >
              <dl className="flex flex-col gap-2.5">
                <KeyValue label={t('dashboard.google.account')}>{data.google.account ?? t('common.none')}</KeyValue>
                {data.google.last_checked_at && (
                  <KeyValue label={t('dashboard.lastChecked')}>
                    <RelativeTime value={data.google.last_checked_at} live={false} />
                  </KeyValue>
                )}
              </dl>
              {!data.google.configured_on_server && <p className="type-footnote text-warning">{msg('google.not_configured')}</p>}
              {data.google.error && <p className="type-footnote text-danger">{msg(data.google.error)}</p>}
              <Button asChild variant="outline" className="self-start">
                <Link to="/google">{t('dashboard.google.manage')}</Link>
              </Button>
            </Panel>

            <Panel
              title={t('dashboard.numbers.title')}
              action={
                data.last_run && (
                  <StatusBadge tone={toneOf(RUN_STATUS_TONE, data.last_run.status)}>{tEnum(t, 'runs.status', data.last_run.status)}</StatusBadge>
                )
              }
              description={
                !data.last_run
                  ? t('dashboard.numbers.noRun')
                  : data.last_run.calendar_name
                    ? t('dashboard.numbers.lastRunAtPair', { name: data.last_run.calendar_name, date: formatDateTime(data.last_run.started_at, locale) })
                    : t('dashboard.numbers.lastRunAt', { date: formatDateTime(data.last_run.started_at, locale) })
              }
              className="split:col-span-2 columns:col-span-1"
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-5">
                <Metric value={formatNumber(data.mapped_events, locale)} label={t('dashboard.numbers.mapped', { count: data.mapped_events })} className="col-span-2" />
                <Metric value={formatNumber(data.last_run?.counts.created ?? 0, locale)} label={t('runs.counts.created')} tone={(data.last_run?.counts.created ?? 0) > 0 ? 'success' : undefined} />
                <Metric value={formatNumber(data.last_run?.counts.updated ?? 0, locale)} label={t('runs.counts.updated')} tone={(data.last_run?.counts.updated ?? 0) > 0 ? 'accent' : undefined} />
                <Metric value={formatNumber(data.last_run?.counts.deleted ?? 0, locale)} label={t('runs.counts.deleted')} tone={(data.last_run?.counts.deleted ?? 0) > 0 ? 'danger' : undefined} />
                <Metric value={formatNumber(data.last_run?.counts.failed ?? 0, locale)} label={t('runs.counts.failed')} tone={(data.last_run?.counts.failed ?? 0) > 0 ? 'danger' : undefined} />
              </div>
              {data.last_run?.message && data.last_run.message.code !== 'sync.success' && (
                <p className="type-footnote text-text-secondary">{msg(data.last_run.message)}</p>
              )}
            </Panel>

            <Panel
              title={t('dashboard.errors.title')}
              className="split:col-span-2 columns:col-span-3"
              action={
                <Button asChild variant="ghost" size="sm" className="text-accent-text">
                  <Link to="/logs?tab=errors">{t('dashboard.errors.all')}</Link>
                </Button>
              }
            >
              {data.recent_errors.length === 0 ? (
                <EmptyState icon={<CircleCheck aria-hidden />} title={t('dashboard.errors.emptyTitle')} description={t('dashboard.errors.emptyBody')} />
              ) : (
                <ul className="flex flex-col">
                  {data.recent_errors.map((entry) => (
                    <li key={entry.id} className="group-row relative flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 [--row-inset:2rem]">
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                      <span className="min-w-0 flex-1 basis-64">{msg(entry.code, entry.params)}</span>
                      {typeof entry.params.pair_id === 'number' && pairNames.has(entry.params.pair_id) && (
                        <StatusBadge tone="neutral">{pairNames.get(entry.params.pair_id)}</StatusBadge>
                      )}
                      <span className="type-footnote shrink-0 text-text-secondary">
                        <RelativeTime value={entry.ts} live={false} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </div>
    </>
  )
}
