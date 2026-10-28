import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, History, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { api, qk } from '@/api/endpoints'
import { useStartRun, useStatus } from '@/api/hooks'
import type { SyncSettings } from '@/api/types'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { Group, Row } from '@/components/common/Group'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryError } from '@/components/common/QueryError'
import { RunFacts, RunItemList } from '@/components/runs/RunDetails'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale } from '@/hooks/use-locale'
import { formatNumber } from '@/lib/format'
import { useMessage } from '@/lib/messages'

/** The sync page shows a preview; the full list lives in the run detail under Protokolle. */
const LATEST_ITEMS = 5

type NumericKey = 'interval_minutes' | 'past_months' | 'future_months' | 'deletion_max_absolute' | 'deletion_max_percent'

/** Ranges from docs/api.md. */
const LIMITS: Record<NumericKey, { min: number; max: number }> = {
  interval_minutes: { min: 1, max: 1440 },
  past_months: { min: 0, max: 120 },
  future_months: { min: 1, max: 120 },
  deletion_max_absolute: { min: 0, max: 100_000 },
  deletion_max_percent: { min: 0, max: 100 },
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
}

function NumberRow({
  field,
  value,
  onChange,
  error,
  label,
  description,
  unit,
}: {
  field: NumericKey
  value: string
  onChange: (v: string) => void
  error: string | null
  label: string
  description?: string
  unit: string
}) {
  const id = useId()
  const errId = `${id}-error`
  return (
    <Row
      label={label}
      htmlFor={id}
      description={
        <>
          {description && <span>{description}</span>}
          {error && (
            <span id={errId} className="block text-danger">
              {error}
            </span>
          )}
        </>
      }
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={LIMITS[field].min}
        max={LIMITS[field].max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? errId : undefined}
        className="h-9 w-[7ch] min-w-20 bg-surface-sunken text-right tabular pointer-coarse:h-11"
      />
      <span className="type-footnote">{unit}</span>
    </Row>
  )
}

function SwitchRow({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId()
  return (
    <Row label={label} htmlFor={id} description={description}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Row>
  )
}

type Draft = Omit<SyncSettings, NumericKey> & Record<NumericKey, string>

function toDraft(s: SyncSettings): Draft {
  return {
    ...s,
    interval_minutes: String(s.interval_minutes),
    past_months: String(s.past_months),
    future_months: String(s.future_months),
    deletion_max_absolute: String(s.deletion_max_absolute),
    deletion_max_percent: String(s.deletion_max_percent),
  }
}

function SettingsForm({ settings }: { settings: SyncSettings }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const zones = useMemo(() => timeZones(), [])
  const tzId = useId()

  const errors = useMemo(() => {
    const out: Partial<Record<NumericKey, string>> = {}
    for (const key of Object.keys(LIMITS) as NumericKey[]) {
      const raw = draft[key]
      const n = Number(raw)
      const { min, max } = LIMITS[key]
      if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) out[key] = t('validation.range', { min, max })
    }
    return out
  }, [draft, t])

  const patch = useMemo(() => {
    const p: Partial<SyncSettings> = {}
    for (const key of Object.keys(settings) as Array<keyof SyncSettings>) {
      const current = key in LIMITS ? Number(draft[key as NumericKey]) : draft[key]
      if (current !== settings[key]) (p as Record<string, unknown>)[key] = current
    }
    return p
  }, [draft, settings])
  const dirty = Object.keys(patch).length > 0
  const valid = Object.keys(errors).length === 0

  const save = useMutation({
    mutationFn: () => api.sync.saveSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.syncSettings, data)
      void qc.invalidateQueries({ queryKey: qk.status })
      void qc.invalidateQueries({ queryKey: qk.googleCalendars })
      toast.success(t('sync.settings.saved'))
    },
    onError: (e) => toast.error(msg(e)),
  })
  const serverFields = save.error instanceof ApiError && Array.isArray(save.error.params.fields) ? (save.error.params.fields as string[]) : []

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const err = (key: NumericKey) => errors[key] ?? (serverFields.includes(key) ? msg('validation.invalid', { fields: [key] }) : null)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (valid && dirty) save.mutate()
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-(--space-section)">
      <Group title={t('sync.settings.schedule.title')} footer={t('sync.settings.schedule.footer')}>
        <SwitchRow label={t('sync.settings.enabled.label')} description={t('sync.settings.enabled.description')} checked={draft.enabled} onChange={(v) => set('enabled', v)} />
        <NumberRow
          field="interval_minutes"
          label={t('sync.settings.interval.label')}
          unit={t('units.minutes', { count: Number(draft.interval_minutes) || 0 })}
          value={draft.interval_minutes}
          onChange={(v) => set('interval_minutes', v)}
          error={err('interval_minutes')}
        />
      </Group>

      <Group title={t('sync.settings.range.title')} footer={t('sync.settings.range.footer')}>
        <NumberRow
          field="past_months"
          label={t('sync.settings.pastMonths.label')}
          unit={t('units.months', { count: Number(draft.past_months) || 0 })}
          value={draft.past_months}
          onChange={(v) => set('past_months', v)}
          error={err('past_months')}
        />
        <NumberRow
          field="future_months"
          label={t('sync.settings.futureMonths.label')}
          unit={t('units.months', { count: Number(draft.future_months) || 0 })}
          value={draft.future_months}
          onChange={(v) => set('future_months', v)}
          error={err('future_months')}
        />
      </Group>

      <Group title={t('sync.settings.deletion.title')} footer={t('sync.settings.deletion.footer')}>
        <SwitchRow
          label={t('sync.settings.deletionDryRun.label')}
          description={t('sync.settings.deletionDryRun.description')}
          checked={draft.deletion_dry_run}
          onChange={(v) => set('deletion_dry_run', v)}
        />
        <NumberRow
          field="deletion_max_absolute"
          label={t('sync.settings.maxAbsolute.label')}
          description={t('sync.settings.maxAbsolute.description')}
          unit={t('units.events', { count: Number(draft.deletion_max_absolute) || 0 })}
          value={draft.deletion_max_absolute}
          onChange={(v) => set('deletion_max_absolute', v)}
          error={err('deletion_max_absolute')}
        />
        <NumberRow
          field="deletion_max_percent"
          label={t('sync.settings.maxPercent.label')}
          description={t('sync.settings.maxPercent.description')}
          unit={t('units.percent')}
          value={draft.deletion_max_percent}
          onChange={(v) => set('deletion_max_percent', v)}
          error={err('deletion_max_percent')}
        />
      </Group>

      <Group title={t('sync.settings.content.title')}>
        <SwitchRow label={t('sync.settings.reminders.label')} description={t('sync.settings.reminders.description')} checked={draft.sync_reminders} onChange={(v) => set('sync_reminders', v)} />
        <SwitchRow
          label={t('sync.settings.descriptions.label')}
          description={t('sync.settings.descriptions.description')}
          checked={draft.sync_descriptions}
          onChange={(v) => set('sync_descriptions', v)}
        />
        <Row label={t('sync.settings.timezone.label')} description={t('sync.settings.timezone.description')}>
          <Select value={draft.default_timezone} onValueChange={(v) => set('default_timezone', v)}>
            <SelectTrigger id={tzId} aria-label={t('sync.settings.timezone.label')} className="h-9 max-w-[16rem] min-w-40 bg-surface-sunken pointer-coarse:h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80 shadow-popover">
              {!zones.includes(draft.default_timezone) && <SelectItem value={draft.default_timezone}>{draft.default_timezone}</SelectItem>}
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Group>

      <Group title={t('sync.settings.target.title')}>
        <SwitchRow
          label={t('sync.settings.allowPrimary.label')}
          description={t('sync.settings.allowPrimary.description')}
          checked={draft.allow_primary_target}
          onChange={(v) => set('allow_primary_target', v)}
        />
        {draft.allow_primary_target && (
          <div className="group-row relative px-3 py-3">
            <Alert className="rounded-lg border-0 bg-warning-soft">
              <TriangleAlert aria-hidden className="text-warning" />
              <AlertTitle className="font-semibold">{t('sync.settings.allowPrimary.warningTitle')}</AlertTitle>
              <AlertDescription className="text-text-primary">{t('sync.settings.allowPrimary.warningBody')}</AlertDescription>
            </Alert>
          </div>
        )}
      </Group>

      {/* Save bar: appears only with unsaved changes and sticks above the tab bar on
          phones, so saving never requires scrolling back. */}
      {dirty && (
        <div className="sticky bottom-[calc(var(--size-tabbar)+env(safe-area-inset-bottom)+0.75rem)] z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl material-chrome py-2 pr-2 pl-4 shadow-popover split:bottom-4">
          <span className="type-footnote mr-auto min-w-0 flex-1 text-text-secondary" role="status">
            {t('sync.settings.unsaved')}
          </span>
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(toDraft(settings))}>
            {t('common.reset')}
          </Button>
          <Button type="submit" disabled={!valid || save.isPending}>
            {save.isPending && <Spinner />}
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  )
}

function RunPanel() {
  const { t } = useTranslation()
  const locale = useLocale()
  const status = useStatus()
  const startRun = useStartRun()
  const [confirmRelease, setConfirmRelease] = useState(false)
  const lastRun = status.data?.last_run ?? null
  const running = status.data?.sync.running ?? false
  const configured = Boolean(status.data?.source && status.data?.target)
  const detail = useQuery({
    queryKey: qk.run(lastRun?.id ?? -1),
    queryFn: () => api.sync.run(lastRun!.id),
    enabled: lastRun !== null && lastRun.status !== 'running',
  })
  const guardTripped = lastRun?.message?.code === 'sync.deletion_guard_tripped'
  const busy = running || startRun.isPending

  return (
    <div className="flex flex-col gap-(--space-section)">
      <Group title={t('sync.run.title')} footer={configured ? t('sync.run.footer') : t('dashboard.sync.notConfigured')}>
        <div className="flex flex-wrap gap-2 p-4">
          <Button className="h-10 px-4 pointer-coarse:h-11" disabled={busy || !configured} onClick={() => startRun.mutate({ dryRun: false })}>
            {busy ? <Spinner /> : <RefreshCw aria-hidden />}
            {running ? t('dashboard.sync.running') : t('actions.syncNow')}
          </Button>
          <Button variant="outline" className="h-10 px-4 pointer-coarse:h-11" disabled={busy || !configured} onClick={() => startRun.mutate({ dryRun: true })}>
            <FlaskConical aria-hidden />
            {t('actions.dryRun')}
          </Button>
        </div>
      </Group>

      {guardTripped && lastRun && (
        <Alert className="rounded-xl border-0 bg-warning-soft px-4 py-3">
          <ShieldAlert aria-hidden className="text-warning" />
          <AlertTitle className="font-semibold">{t('sync.guard.title')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 text-text-primary">
            <p>{t('sync.guard.body', { count: lastRun.deletions.planned, formatted: formatNumber(lastRun.deletions.planned, locale) })}</p>
            <Button variant="outline" className="self-start" disabled={busy} onClick={() => setConfirmRelease(true)}>
              {t('sync.guard.release')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Group title={t('sync.latest.title')}>
        {status.isPending ? (
          <div className="p-4">
            <Skeleton className="h-32" />
          </div>
        ) : status.isError ? (
          <div className="p-3">
            <QueryError error={status.error} onRetry={() => void status.refetch()} />
          </div>
        ) : !lastRun ? (
          <EmptyState icon={<History aria-hidden />} title={t('sync.latest.emptyTitle')} description={t('sync.latest.emptyBody')} />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <RunFacts run={lastRun} />
            {lastRun.status === 'running' ? (
              <p className="flex items-center gap-2 text-text-secondary">
                <Spinner />
                {t('dashboard.sync.inProgress')}
              </p>
            ) : detail.isPending ? (
              <Skeleton className="h-24" />
            ) : detail.isError ? (
              <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <div className="flex flex-col gap-1">
                <h3 className="type-footnote font-semibold text-text-secondary">{t('runs.items.title')}</h3>
                <RunItemList items={detail.data.items.slice(0, LATEST_ITEMS)} />
                {detail.data.items.length > LATEST_ITEMS && (
                  <Button asChild variant="ghost" size="sm" className="self-start text-accent-text">
                    <Link to={`/logs?run=${detail.data.id}`}>{t('sync.latest.showAll', { count: detail.data.items.length })}</Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Group>

      <ConfirmDialog
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        title={t('sync.guard.confirmTitle')}
        description={
          <>
            <p>{t('sync.guard.confirmBody', { count: lastRun?.deletions.planned ?? 0, formatted: formatNumber(lastRun?.deletions.planned ?? 0, locale) })}</p>
            <p>{t('sync.guard.confirmOnce')}</p>
          </>
        }
        confirmLabel={t('sync.guard.confirm')}
        destructive
        onConfirm={() => startRun.mutate({ dryRun: false, allowMassDeletion: true })}
      />
    </div>
  )
}

export function SyncPage() {
  const { t } = useTranslation()
  const settings = useQuery({ queryKey: qk.syncSettings, queryFn: api.sync.settings })
  return (
    <>
      <PageHeader title={t('sync.title')} description={t('sync.description')} />
      <div className="mt-4 grid items-start gap-(--space-section) columns:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] columns:gap-x-6">
        <div className="columns:order-2">
          <RunPanel />
        </div>
        <div className="columns:order-1">
          {settings.isPending ? (
            <div className="flex flex-col gap-4" aria-hidden>
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-40 rounded-xl" />
            </div>
          ) : settings.isError ? (
            <QueryError error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            // Remount when the server values change (after a save), not on identical refetches.
            <SettingsForm key={JSON.stringify(settings.data)} settings={settings.data} />
          )}
        </div>
      </div>
    </>
  )
}
