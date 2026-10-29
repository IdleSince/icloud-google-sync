import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarMinus,
  CalendarPlus,
  CalendarX2,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleSlash,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  PlugZap,
  RefreshCw,
  Search,
  Stethoscope,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { api, qk } from '@/api/endpoints'
import { useInvalidatePairs, useStatus } from '@/api/hooks'
import type { DiagnosticStep, Diagnostics, DiscoveredCalendar, ICloudTestResult, Pair } from '@/api/types'
import { ColorDot } from '@/components/common/ColorDot'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { Group, Row } from '@/components/common/Group'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryError } from '@/components/common/QueryError'
import { RelativeTime } from '@/components/common/RelativeTime'
import { StatusBadge, type Tone } from '@/components/common/StatusBadge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useLocale } from '@/hooks/use-locale'
import { displayOwner, formatDateTime } from '@/lib/format'
import { tEnum, useMessage } from '@/lib/messages'
import { sharedCalendarsToAdd } from '@/lib/pairs'
import { ICLOUD_TONE, toneOf } from '@/lib/status'
import { cn } from '@/lib/utils'

const APP_PASSWORD_PATTERN = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

function CredentialsForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const appleIdId = useId()
  const passwordId = useId()
  const [appleId, setAppleId] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [touched, setTouched] = useState({ appleId: false, password: false })

  const appleIdError = touched.appleId && appleId && !EMAIL_PATTERN.test(appleId.trim()) ? msg('icloud.invalid_apple_id') : null
  const passwordError =
    touched.password && password && !APP_PASSWORD_PATTERN.test(password.trim()) ? msg('icloud.invalid_app_password_format') : null

  const save = useMutation({
    mutationFn: () => api.icloud.saveCredentials(appleId.trim(), password.trim()),
    onSuccess: () => {
      toast.success(t('icloud.credentials.saved'))
      setPassword('')
      void qc.invalidateQueries({ queryKey: qk.status })
      void qc.invalidateQueries({ queryKey: qk.icloudCalendars })
      onDone()
    },
  })

  const serverError = save.error
  const serverFields =
    serverError instanceof ApiError && Array.isArray(serverError.params.fields) ? (serverError.params.fields as string[]) : []

  const valid = EMAIL_PATTERN.test(appleId.trim()) && APP_PASSWORD_PATTERN.test(password.trim())
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setTouched({ appleId: true, password: true })
    if (valid) save.mutate()
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5 p-4">
      <Field data-invalid={Boolean(appleIdError) || serverFields.includes('apple_id') || undefined}>
        <FieldLabel htmlFor={appleIdId}>{t('icloud.credentials.appleId')}</FieldLabel>
        <Input
          id={appleIdId}
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t('icloud.credentials.appleIdPlaceholder')}
          value={appleId}
          onChange={(e) => setAppleId(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, appleId: true }))}
          aria-invalid={Boolean(appleIdError) || undefined}
          className="h-10 pointer-coarse:h-11"
        />
        {appleIdError && <FieldError>{appleIdError}</FieldError>}
      </Field>
      <Field data-invalid={Boolean(passwordError) || serverFields.includes('app_password') || undefined}>
        <FieldLabel htmlFor={passwordId}>{t('icloud.credentials.appPassword')}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={passwordId}
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('icloud.credentials.appPasswordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((s) => ({ ...s, password: true }))}
            aria-invalid={Boolean(passwordError) || undefined}
            className="h-10 flex-1 font-mono pointer-coarse:h-11"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            className="size-10 pointer-coarse:size-11"
            aria-pressed={reveal}
            aria-label={reveal ? t('icloud.credentials.hidePassword') : t('icloud.credentials.showPassword')}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </div>
        {passwordError ? <FieldError>{passwordError}</FieldError> : <FieldDescription>{t('icloud.credentials.appPasswordFormat')}</FieldDescription>}
      </Field>

      <Alert className="rounded-xl border-0 bg-accent-soft">
        <KeyRound aria-hidden className="text-accent-text" />
        <AlertTitle className="font-semibold">{t('icloud.credentials.hint.title')}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2 text-text-primary">
          <ol className="list-decimal pl-5">
            <li>
              <Trans
                i18nKey="icloud.credentials.hint.step1"
                components={{ site: <a href="https://account.apple.com" target="_blank" rel="noreferrer noopener" className="font-medium underline underline-offset-2" /> }}
              />
            </li>
            <li>{t('icloud.credentials.hint.step2')}</li>
            <li>{t('icloud.credentials.hint.step3')}</li>
          </ol>
          <p className="font-medium">{t('icloud.credentials.hint.noMainPassword')}</p>
        </AlertDescription>
      </Alert>

      {serverError && (
        <Alert variant="destructive" className="rounded-xl border-0 bg-danger-soft">
          <TriangleAlert aria-hidden />
          <AlertDescription className="text-text-primary">{msg(serverError)}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-10 px-4 pointer-coarse:h-11" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {t('icloud.credentials.save')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" className="h-10 pointer-coarse:h-11" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
      <p className="type-footnote text-text-secondary">{t('icloud.credentials.testedBeforeSave')}</p>
    </form>
  )
}

function TestResult({ result }: { result: ICloudTestResult }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const item = (ok: boolean, label: string) => (
    <li className="flex items-center gap-2">
      {ok ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <XCircle className="size-4 text-danger" aria-hidden />}
      <span>{label}</span>
      <span className="sr-only">{ok ? t('common.yes') : t('common.no')}</span>
    </li>
  )
  return (
    <div role="status" className="flex flex-col gap-2 px-4 py-3">
      <p className={cn('font-medium', result.ok ? 'text-success' : 'text-danger')}>
        {result.ok ? t('icloud.test.ok') : t('icloud.test.failed')}
      </p>
      {result.error && <p className="text-text-primary">{msg(result.error)}</p>}
      <ul className="flex flex-col gap-1 text-text-secondary">
        {item(result.principal_found, t('icloud.test.principal'))}
        {item(result.calendar_home_found, t('icloud.test.calendarHome'))}
      </ul>
    </div>
  )
}

function AccountSection() {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const status = useStatus()
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const test = useMutation({
    mutationFn: api.icloud.test,
    onSuccess: (r) => {
      if (r.ok) toast.success(t('icloud.test.ok'))
      else toast.error(r.error ? msg(r.error) : t('icloud.test.failed'))
      void qc.invalidateQueries({ queryKey: qk.status })
    },
    onError: (e) => toast.error(msg(e)),
  })
  const remove = useMutation({
    mutationFn: api.icloud.deleteCredentials,
    onSuccess: () => {
      toast.success(t('icloud.credentials.removed'))
      test.reset()
      void qc.invalidateQueries({ queryKey: qk.status })
      qc.removeQueries({ queryKey: qk.icloudCalendars })
      qc.removeQueries({ queryKey: qk.icloudDiagnostics })
    },
    onError: (e) => toast.error(msg(e)),
  })

  if (status.isPending) return <Skeleton className="h-48 rounded-xl" />
  if (status.isError) return <QueryError error={status.error} onRetry={() => void status.refetch()} />
  const icloud = status.data.icloud

  return (
    <Group id="icloud-account" title={t('icloud.credentials.title')} footer={!icloud.configured || editing ? undefined : t('icloud.credentials.footer')}>
      {icloud.configured && !editing ? (
        <>
          <Row label={t('icloud.credentials.appleId')}>
            <span className="break-all text-text-primary">{icloud.account_masked}</span>
          </Row>
          <Row label={t('icloud.credentials.status')}>
            <StatusBadge tone={toneOf(ICLOUD_TONE, icloud.status)}>{tEnum(t, 'status.icloud', icloud.status)}</StatusBadge>
          </Row>
          {icloud.last_checked_at && (
            <Row label={t('dashboard.lastChecked')}>
              <RelativeTime value={icloud.last_checked_at} live={false} />
            </Row>
          )}
          {icloud.error && (
            <Row>
              <p className="text-danger">{msg(icloud.error)}</p>
            </Row>
          )}
          {test.data && <TestResult result={test.data} />}
          <div className="group-row relative flex flex-wrap gap-2 px-4 py-3">
            <Button variant="outline" className="pointer-coarse:h-11" disabled={test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Spinner /> : <PlugZap aria-hidden />}
              {t('actions.testConnection')}
            </Button>
            <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setEditing(true)}>
              <KeyRound aria-hidden />
              {t('icloud.credentials.change')}
            </Button>
            <Button variant="destructive" className="pointer-coarse:h-11" disabled={remove.isPending} onClick={() => setConfirmRemove(true)}>
              {remove.isPending ? <Spinner /> : <Trash2 aria-hidden />}
              {t('icloud.credentials.remove')}
            </Button>
          </div>
        </>
      ) : (
        <CredentialsForm onDone={() => setEditing(false)} onCancel={icloud.configured ? () => setEditing(false) : undefined} />
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('icloud.credentials.removeConfirm.title')}
        description={<p>{t('icloud.credentials.removeConfirm.body')}</p>}
        confirmLabel={t('icloud.credentials.remove')}
        destructive
        onConfirm={() => remove.mutate()}
      />
    </Group>
  )
}

/* ------------------------------------------------------------------ */
/* Calendars                                                           */
/* ------------------------------------------------------------------ */

function disabledReason(cal: DiscoveredCalendar, t: (k: string) => string, msg: (e: unknown) => string): string | null {
  if (!cal.supports_events) return t('icloud.calendars.reason.noEvents')
  if (!cal.readable) return cal.error ? msg(cal.error) : t('icloud.calendars.reason.notReadable')
  return null
}

interface CalendarRowProps {
  cal: DiscoveredCalendar
  pair: Pair | undefined
  disabled: string | null
  busy: boolean
  pending: boolean
  onAdd: () => void
  onStop: () => void
}

function CalendarRow({ cal, pair, disabled, busy, pending, onAdd, onStop }: CalendarRowProps) {
  const { t } = useTranslation()
  const msg = useMessage()
  const metaId = useId()
  const ownershipTone: Tone = cal.ownership === 'shared' ? 'accent' : 'neutral'
  const synced = cal.pair_id !== null
  return (
    // Label block and action share one line; the action wraps below on narrow phones.
    <li className="group-row relative flex min-h-(--size-row-min) flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className={cn('flex min-w-[min(14rem,100%)] flex-1 flex-col gap-1', disabled && 'opacity-70')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ColorDot color={cal.color} />
          <span className="font-medium break-words text-text-primary">{cal.name}</span>
          <StatusBadge tone={ownershipTone}>{tEnum(t, 'calendar.ownership', cal.ownership)}</StatusBadge>
          {synced &&
            (pair && !pair.enabled ? (
              <StatusBadge tone="neutral">{t('pairs.pausedBadge')}</StatusBadge>
            ) : (
              <StatusBadge tone="success" icon={<RefreshCw aria-hidden />}>
                {t('icloud.calendars.synced')}
              </StatusBadge>
            ))}
        </div>
        <div id={metaId} className="type-footnote flex flex-wrap gap-x-3 gap-y-0.5 text-text-secondary">
          {cal.owner && <span>{t('calendar.ownerValue', { owner: displayOwner(cal.owner) })}</span>}
          <span>{tEnum(t, 'calendar.access', cal.access)}</span>
          {cal.event_count !== null && <span>{t('calendar.eventCount', { count: cal.event_count })}</span>}
          {disabled && (
            <span className="inline-flex items-center gap-1 text-danger">
              <CircleSlash className="size-3.5" aria-hidden />
              {disabled}
            </span>
          )}
          {!disabled && cal.error && <span className="text-warning">{msg(cal.error)}</span>}
        </div>
      </div>
      {synced ? (
        <Button
          variant="ghost"
          className="text-text-secondary pointer-coarse:h-11"
          disabled={busy}
          aria-label={t('icloud.calendars.stopLabel', { name: cal.name })}
          onClick={onStop}
        >
          {pending ? <Spinner /> : <CalendarMinus aria-hidden />}
          {t('icloud.calendars.stop')}
        </Button>
      ) : (
        !disabled && (
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            disabled={busy}
            aria-label={t('icloud.calendars.addLabel', { name: cal.name })}
            aria-describedby={metaId}
            onClick={onAdd}
          >
            {pending ? <Spinner /> : <CalendarPlus aria-hidden />}
            {t('icloud.calendars.add')}
          </Button>
        )
      )}
    </li>
  )
}

function CalendarsSection({ configured }: { configured: boolean }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const status = useStatus()
  const invalidate = useInvalidatePairs()
  const calendars = useQuery({ queryKey: qk.icloudCalendars, queryFn: api.icloud.calendars, enabled: configured })
  const [stopCandidate, setStopCandidate] = useState<{ pairId: number; name: string } | null>(null)

  const add = useMutation({
    mutationFn: (cal: DiscoveredCalendar) => api.pairs.create(cal.url),
    onSuccess: ({ pair }) => {
      if (pair.target) toast.success(t('icloud.calendars.added', { name: pair.source.name, target: pair.target.name }))
      else toast.success(t('icloud.calendars.addedNoTarget', { name: pair.source.name }))
    },
    onError: (e) => toast.error(msg(e)),
    onSettled: invalidate,
  })

  // One request per calendar, one after the other: the backend creates a Google calendar
  // for each, and sequential calls stay well inside Google's rate limit.
  const addAll = useMutation({
    mutationFn: async (list: DiscoveredCalendar[]) => {
      let added = 0
      const errors: unknown[] = []
      for (const cal of list) {
        try {
          await api.pairs.create(cal.url)
          added += 1
        } catch (e) {
          errors.push(e)
        }
      }
      return { added, errors }
    },
    onSuccess: ({ added, errors }) => {
      if (errors.length === 0) toast.success(t('icloud.calendars.addedAll', { count: added }))
      else if (added > 0)
        toast.warning(t('icloud.calendars.addedAll', { count: added }), { description: t('icloud.calendars.addAllFailed', { count: errors.length }) })
      else toast.error(t('icloud.calendars.addAllFailed', { count: errors.length }), { description: msg(errors[0]) })
    },
    onSettled: invalidate,
  })

  const remove = useMutation({
    mutationFn: (vars: { pairId: number; name: string }) => api.pairs.remove(vars.pairId),
    onSuccess: (_r, vars) => toast.success(t('icloud.calendars.stopped', { name: vars.name })),
    onError: (e) => toast.error(msg(e)),
    onSettled: invalidate,
  })

  const busy = add.isPending || addAll.isPending || remove.isPending
  const pairsById = new Map((status.data?.pairs ?? []).map((p) => [p.id, p]))

  const refresh = (
    <Button
      variant="ghost"
      size="sm"
      className="text-accent-text"
      disabled={!configured || calendars.isFetching}
      onClick={() => void calendars.refetch()}
    >
      {calendars.isFetching ? <Spinner /> : <Search aria-hidden />}
      {t('icloud.calendars.refresh')}
    </Button>
  )

  let body
  if (!configured) {
    body = <EmptyState icon={<Lock aria-hidden />} title={t('icloud.calendars.needCredentialsTitle')} description={t('icloud.calendars.needCredentialsBody')} />
  } else if (calendars.isPending) {
    body = (
      <div className="flex flex-col gap-3 p-4" aria-hidden>
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  } else if (calendars.isError) {
    body = (
      <div className="p-3">
        <QueryError error={calendars.error} onRetry={() => void calendars.refetch()} />
      </div>
    )
  } else if (calendars.data.calendars.length === 0) {
    body = <EmptyState icon={<CalendarX2 aria-hidden />} title={t('icloud.calendars.emptyTitle')} description={t('icloud.calendars.emptyBody')} />
  } else {
    const list = calendars.data.calendars
    const toAdd = sharedCalendarsToAdd(list)
    body = (
      <>
        {toAdd.length > 0 && (
          <div className="group-row relative flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
            <p className="min-w-[min(14rem,100%)] flex-1 text-text-primary">{t('icloud.calendars.addAllHint', { count: toAdd.length })}</p>
            <Button className="pointer-coarse:h-11" disabled={busy} onClick={() => addAll.mutate(toAdd)}>
              {addAll.isPending ? <Spinner /> : <CalendarPlus aria-hidden />}
              {t('icloud.calendars.addAll')}
            </Button>
          </div>
        )}
        <ul aria-label={t('icloud.calendars.title')} aria-busy={busy || undefined}>
          {list.map((cal) => (
            <CalendarRow
              key={cal.id}
              cal={cal}
              pair={cal.pair_id !== null ? pairsById.get(cal.pair_id) : undefined}
              disabled={disabledReason(cal, t, msg)}
              busy={busy}
              pending={(add.isPending && add.variables?.url === cal.url) || (remove.isPending && remove.variables?.pairId === cal.pair_id)}
              onAdd={() => add.mutate(cal)}
              onStop={() => cal.pair_id !== null && setStopCandidate({ pairId: cal.pair_id, name: cal.name })}
            />
          ))}
        </ul>
      </>
    )
  }

  return (
    <Group id="icloud-calendars" title={t('icloud.calendars.title')} action={refresh} footer={t('icloud.calendars.footer')}>
      {body}
      <ConfirmDialog
        open={stopCandidate !== null}
        onOpenChange={(v) => !v && setStopCandidate(null)}
        title={t('icloud.calendars.stopConfirm.title', { name: stopCandidate?.name ?? '' })}
        description={
          <>
            <p>{t('icloud.calendars.stopConfirm.body')}</p>
            <p>{t('icloud.calendars.stopConfirm.nothingDeleted')}</p>
          </>
        }
        confirmLabel={t('icloud.calendars.stopConfirm.confirm')}
        onConfirm={() => {
          if (stopCandidate) remove.mutate(stopCandidate)
          setStopCandidate(null)
        }}
      />
    </Group>
  )
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

const STEP_ICON: Record<string, { icon: typeof CheckCircle2; className: string }> = {
  ok: { icon: CheckCircle2, className: 'text-success' },
  warn: { icon: CircleAlert, className: 'text-warning' },
  fail: { icon: XCircle, className: 'text-danger' },
  skipped: { icon: CircleSlash, className: 'text-text-tertiary' },
}

function StepRow({ step }: { step: DiagnosticStep }) {
  const { t, i18n } = useTranslation()
  const meta = STEP_ICON[step.status] ?? STEP_ICON.skipped!
  const Icon = meta.icon
  const known = i18n.exists(`icloud.diagnostics.steps.${step.key}.title`)
  const title = known ? t(`icloud.diagnostics.steps.${step.key}.title`) : t('icloud.diagnostics.steps.unknown', { key: step.key })
  const detailKey = `icloud.diagnostics.steps.${step.key}.${step.status}`
  const detail = known && i18n.exists(detailKey) ? t(detailKey, step.params as Record<string, unknown>) : null
  return (
    <li className="group-row relative flex items-start gap-3 px-4 py-3 [--row-inset:2.75rem]">
      <Icon className={cn('mt-0.5 size-5 shrink-0', meta.className)} aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-text-primary">
          {title}
          <span className="sr-only">: {tEnum(t, 'icloud.diagnostics.status', step.status)}</span>
        </span>
        {detail && <span className="type-footnote text-text-secondary">{detail}</span>}
      </div>
    </li>
  )
}

function Conclusion({ diagnostics }: { diagnostics: Diagnostics }) {
  const { t, i18n } = useTranslation()
  const c = diagnostics.conclusion
  const known = i18n.exists(`icloud.diagnostics.conclusion.${c}.title`)
  const sharedProblem = c === 'shared_not_listed' || c === 'shared_not_readable'
  const tone = c === 'shared_accessible' ? 'success' : sharedProblem ? 'warning' : 'danger'
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? CircleAlert : XCircle
  return (
    <Alert
      className={cn(
        'rounded-xl border-0 px-4 py-3',
        tone === 'success' && 'bg-success-soft',
        tone === 'warning' && 'bg-warning-soft',
        tone === 'danger' && 'bg-danger-soft',
      )}
    >
      <Icon
        aria-hidden
        className={cn(tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}
      />
      <AlertTitle className="font-semibold">
        {known ? t(`icloud.diagnostics.conclusion.${c}.title`) : t('icloud.diagnostics.conclusion.unknown.title')}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-text-primary">
        <p>{known ? t(`icloud.diagnostics.conclusion.${c}.body`) : t('icloud.diagnostics.conclusion.unknown.body', { code: c })}</p>
        {sharedProblem && (
          <div className="flex flex-col gap-1.5">
            <p className="font-semibold">{t('icloud.diagnostics.prerequisites.title')}</p>
            <ul className="list-disc pl-5">
              <li>{t('icloud.diagnostics.prerequisites.accepted')}</li>
              <li>{t('icloud.diagnostics.prerequisites.web')}</li>
              <li>{t('icloud.diagnostics.prerequisites.sameAccount')}</li>
              <li>{t('icloud.diagnostics.prerequisites.wait')}</li>
            </ul>
            <p className="text-text-secondary">{t('icloud.diagnostics.prerequisites.noPublic')}</p>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}

function DiagnosticsSection({ configured }: { configured: boolean }) {
  const { t } = useTranslation()
  const locale = useLocale()
  const diagnostics = useQuery({ queryKey: qk.icloudDiagnostics, queryFn: api.icloud.diagnostics, enabled: false, retry: false })
  const run = (
    <Button variant="ghost" size="sm" className="text-accent-text" disabled={diagnostics.isFetching} onClick={() => void diagnostics.refetch()}>
      {diagnostics.isFetching ? <Spinner /> : <Stethoscope aria-hidden />}
      {diagnostics.data ? t('icloud.diagnostics.rerun') : t('icloud.diagnostics.run')}
    </Button>
  )

  let body
  if (diagnostics.isFetching && !diagnostics.data) {
    body = (
      <div className="flex flex-col gap-3 p-4" aria-hidden>
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    )
  } else if (diagnostics.isError) {
    body = (
      <div className="p-3">
        <QueryError error={diagnostics.error} onRetry={() => void diagnostics.refetch()} />
      </div>
    )
  } else if (!diagnostics.data) {
    body = (
      <EmptyState
        icon={<Stethoscope aria-hidden />}
        title={t('icloud.diagnostics.introTitle')}
        description={configured ? t('icloud.diagnostics.introBody') : t('icloud.calendars.needCredentialsBody')}
        action={
          <Button className="pointer-coarse:h-11" disabled={diagnostics.isFetching} onClick={() => void diagnostics.refetch()}>
            <Stethoscope aria-hidden />
            {t('icloud.diagnostics.run')}
          </Button>
        }
      />
    )
  } else {
    const d = diagnostics.data
    body = (
      <div className="flex flex-col">
        <div className="p-3">
          <Conclusion diagnostics={d} />
        </div>
        <ol aria-label={t('icloud.diagnostics.stepsLabel')}>
          {d.steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
        <Collapsible className="group-row relative">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="pressable group flex min-h-(--size-row-min) w-full items-center justify-between gap-3 px-4 text-left text-accent-text hover:bg-fill"
            >
              <span>{t('icloud.diagnostics.raw', { count: d.raw.length })}</span>
              <ChevronDown className="size-4 transition-transform duration-(--duration-fade) group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 px-4 pb-4">
              {d.raw.length === 0 && <p className="text-text-secondary">{t('icloud.diagnostics.rawEmpty')}</p>}
              {d.raw.map((r) => (
                <div key={r.url} className="flex flex-col gap-1">
                  <p className="type-footnote font-mono break-all text-text-secondary">{r.url}</p>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono type-caption leading-relaxed text-text-primary">
                    {JSON.stringify({ resourcetype: r.resourcetype, properties: r.properties }, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    )
  }

  return (
    <Group
      id="icloud-diagnostics"
      title={t('icloud.diagnostics.title')}
      action={diagnostics.data ? run : undefined}
      footer={diagnostics.data ? t('icloud.diagnostics.checkedAt', { date: formatDateTime(diagnostics.data.checked_at, locale) }) : t('icloud.diagnostics.footer')}
    >
      {body}
    </Group>
  )
}

/* ------------------------------------------------------------------ */

export function ICloudPage() {
  const { t } = useTranslation()
  const status = useStatus()
  const configured = status.data?.icloud.configured ?? false
  return (
    <>
      <PageHeader title={t('icloud.title')} description={t('icloud.description')} />
      {/* Phone: one column — account, calendar choice, diagnostics.
          Wide: setup on the left, diagnostics as its own column on the right. */}
      <div className="mt-4 grid items-start gap-(--space-section) columns:grid-cols-2 columns:gap-x-6">
        <div className="flex min-w-0 flex-col gap-(--space-section)">
          <AccountSection />
          <CalendarsSection configured={configured} />
        </div>
        <div className="min-w-0">
          <DiagnosticsSection configured={configured} />
        </div>
      </div>
    </>
  )
}
