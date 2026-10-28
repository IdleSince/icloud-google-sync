import { CircleMinus, CirclePlus, CircleX, Inbox, PencilLine, RotateCcw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RunItem, RunItemAction, RunSummary } from '@/api/types'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useLocale } from '@/hooks/use-locale'
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format'
import { tEnum, useMessage } from '@/lib/messages'
import { RUN_STATUS_TONE, toneOf } from '@/lib/status'
import { cn } from '@/lib/utils'

const ACTION_META: Record<RunItemAction, { icon: typeof CirclePlus; className: string }> = {
  create: { icon: CirclePlus, className: 'text-success' },
  update: { icon: PencilLine, className: 'text-accent-text' },
  delete: { icon: CircleMinus, className: 'text-danger' },
  reset_instance: { icon: RotateCcw, className: 'text-accent-text' },
  skip_delete: { icon: ShieldAlert, className: 'text-warning' },
  error: { icon: CircleX, className: 'text-danger' },
}

/** Key facts of a run as a definition list that wraps on narrow screens. */
export function RunFacts({ run }: { run: RunSummary }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const locale = useLocale()
  const counts: Array<[keyof RunSummary['counts'], string]> = [
    ['created', 'text-success'],
    ['updated', 'text-accent-text'],
    ['deleted', 'text-danger'],
    ['unchanged', 'text-text-primary'],
    ['failed', 'text-text-primary'],
  ]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={toneOf(RUN_STATUS_TONE, run.status)}>{tEnum(t, 'runs.status', run.status)}</StatusBadge>
        <StatusBadge tone="neutral">{tEnum(t, 'runs.trigger', run.trigger)}</StatusBadge>
        {run.dry_run && <StatusBadge tone="warning">{t('runs.dryRunBadge')}</StatusBadge>}
      </div>
      {run.message && <p className="text-text-primary">{msg(run.message)}</p>}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(min(9rem,100%),1fr))] gap-x-4 gap-y-3">
        <div>
          <dt className="type-footnote text-text-secondary">{t('runs.startedAt')}</dt>
          <dd className="tabular">{formatDateTime(run.started_at, locale, { seconds: true })}</dd>
        </div>
        <div>
          <dt className="type-footnote text-text-secondary">{t('runs.duration')}</dt>
          <dd className="tabular">{run.duration_ms !== null ? formatDuration(run.duration_ms, locale) : t('common.none')}</dd>
        </div>
        <div>
          <dt className="type-footnote text-text-secondary">{t('runs.sourceEvents')}</dt>
          <dd className="tabular">{run.source_events !== null ? formatNumber(run.source_events, locale) : t('common.none')}</dd>
        </div>
        {counts.map(([key, cls]) => (
          <div key={key}>
            <dt className="type-footnote text-text-secondary">{t(`runs.counts.${key}`)}</dt>
            <dd className={cn('tabular font-semibold', cls)}>{formatNumber(run.counts[key], locale)}</dd>
          </div>
        ))}
      </dl>
      {(run.deletions.planned > 0 || run.deletions.blocked) && (
        <p className="type-footnote text-text-secondary">
          {t('runs.deletions.summary', {
            planned: formatNumber(run.deletions.planned, locale),
            executed: formatNumber(run.deletions.executed, locale),
          })}
          {run.deletions.blocked && <span className="ml-1">{t('runs.deletions.blocked')}</span>}
          {run.deletions.dry_run && <span className="ml-1">{t('runs.deletions.dryRun')}</span>}
        </p>
      )}
    </div>
  )
}

export function RunItemList({ items }: { items: RunItem[] }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const locale = useLocale()
  if (items.length === 0) {
    return <EmptyState icon={<Inbox aria-hidden />} title={t('runs.items.emptyTitle')} description={t('runs.items.emptyBody')} />
  }
  return (
    <ul className="flex flex-col" aria-label={t('runs.items.title')}>
      {items.map((item, index) => {
        const meta = ACTION_META[item.action] ?? ACTION_META.error
        const Icon = meta.icon
        return (
          <li key={index} className="group-row relative flex items-start gap-3 py-2.5 [--row-inset:2rem]">
            <Icon className={cn('mt-0.5 size-5 shrink-0', meta.className)} aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium break-words text-text-primary">{item.title || t('runs.items.untitled')}</span>
                <span className="type-footnote text-text-secondary">{tEnum(t, 'runs.action', item.action)}</span>
                {item.planned_only && <span className="type-footnote text-warning">{t('runs.items.plannedOnly')}</span>}
              </div>
              {item.start && (
                <span className="type-footnote tabular flex flex-wrap gap-x-2 text-text-secondary">
                  <span>{formatDateTime(item.start, locale)}</span>
                  {item.recurrence_id && <span>{t('runs.items.instance')}</span>}
                </span>
              )}
              {item.error && <span className="type-footnote text-danger">{msg(item.error)}</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
