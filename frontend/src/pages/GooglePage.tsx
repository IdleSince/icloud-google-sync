import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, CalendarX2, CircleSlash, Info, Link2, Lock, PlugZap, ShieldPlus, TriangleAlert, Unplug } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, qk } from '@/api/endpoints'
import { useStatus } from '@/api/hooks'
import type { GoogleCalendar } from '@/api/types'
import { ColorDot } from '@/components/common/ColorDot'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { Group, Row } from '@/components/common/Group'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryError } from '@/components/common/QueryError'
import { RelativeTime } from '@/components/common/RelativeTime'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { tEnum, useMessage } from '@/lib/messages'
import { GOOGLE_TONE, toneOf } from '@/lib/status'
import { cn } from '@/lib/utils'

/** `?connected=1` / `?error=<code>` from the OAuth callback → toast once, then clean the URL. */
function useOAuthReturn() {
  const [params, setParams] = useSearchParams()
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const handled = useRef(false)
  useEffect(() => {
    if (handled.current) return
    const connected = params.get('connected')
    const error = params.get('error')
    if (!connected && !error) return
    handled.current = true
    if (connected === '1') toast.success(t('google.oauth.connected'))
    else if (error) toast.error(msg(error), { duration: 10_000 })
    void qc.invalidateQueries({ queryKey: qk.status })
    void qc.invalidateQueries({ queryKey: qk.googleCalendars })
    setParams({}, { replace: true })
  }, [params, setParams, t, msg, qc])
}

function useStartOAuth() {
  const msg = useMessage()
  return useMutation({
    mutationFn: (extended: boolean) => api.google.startOAuth(extended),
    onSuccess: ({ authorization_url }) => {
      window.location.assign(authorization_url)
    },
    onError: (e) => toast.error(msg(e)),
  })
}

/* ------------------------------------------------------------------ */

function ConnectionSection() {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const status = useStatus()
  const oauth = useStartOAuth()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const test = useMutation({
    mutationFn: api.google.test,
    onSuccess: (r) => {
      if (r.ok) toast.success(t('google.test.ok', { account: r.account ?? '' }))
      else toast.error(r.error ? msg(r.error) : t('google.test.failed'))
      void qc.invalidateQueries({ queryKey: qk.status })
    },
    onError: (e) => toast.error(msg(e)),
  })
  const disconnect = useMutation({
    mutationFn: api.google.disconnect,
    onSuccess: () => {
      toast.success(t('google.connection.disconnected'))
      void qc.invalidateQueries({ queryKey: qk.status })
      qc.removeQueries({ queryKey: qk.googleCalendars })
    },
    onError: (e) => toast.error(msg(e)),
  })

  if (status.isPending) return <Skeleton className="h-48 rounded-xl" />
  if (status.isError) return <QueryError error={status.error} onRetry={() => void status.refetch()} />
  const g = status.data.google

  if (!g.configured_on_server) {
    return (
      <Group title={t('google.connection.title')}>
        <EmptyState icon={<Lock aria-hidden />} title={t('google.connection.serverMissingTitle')} description={msg('google.not_configured')} />
      </Group>
    )
  }

  const pendingExtended = oauth.isPending && oauth.variables === true
  const pendingBasic = oauth.isPending && oauth.variables === false

  return (
    <div className="flex flex-col gap-(--space-section)">
      <Group title={t('google.connection.title')} footer={g.connected ? undefined : t('google.connection.footer')}>
        {g.connected ? (
          <>
            <Row label={t('google.connection.account')}>
              <span className="break-all text-text-primary">{g.account ?? t('common.none')}</span>
            </Row>
            <Row label={t('google.connection.status')}>
              <StatusBadge tone={toneOf(GOOGLE_TONE, g.status)}>{tEnum(t, 'status.google', g.status)}</StatusBadge>
            </Row>
            <Row label={t('google.connection.access')}>
              <StatusBadge tone={g.extended_access ? 'accent' : 'neutral'}>
                {g.extended_access ? t('google.connection.accessExtended') : t('google.connection.accessBasic')}
              </StatusBadge>
            </Row>
            {g.last_checked_at && (
              <Row label={t('dashboard.lastChecked')}>
                <RelativeTime value={g.last_checked_at} live={false} />
              </Row>
            )}
            {g.error && (
              <Row>
                <p className="text-danger">{msg(g.error)}</p>
              </Row>
            )}
            <div className="group-row relative flex flex-wrap gap-2 px-4 py-3">
              {g.status === 'reauth_required' && (
                <Button className="pointer-coarse:h-11" disabled={oauth.isPending} onClick={() => oauth.mutate(g.extended_access)}>
                  {oauth.isPending ? <Spinner /> : <Link2 aria-hidden />}
                  {t('google.connection.reconnect')}
                </Button>
              )}
              <Button variant="outline" className="pointer-coarse:h-11" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? <Spinner /> : <PlugZap aria-hidden />}
                {t('actions.testConnection')}
              </Button>
              <Button variant="destructive" className="pointer-coarse:h-11" disabled={disconnect.isPending} onClick={() => setConfirmDisconnect(true)}>
                {disconnect.isPending ? <Spinner /> : <Unplug aria-hidden />}
                {t('google.connection.disconnect')}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-text-secondary">{t('google.connection.intro')}</p>
            <Button className="h-10 self-start px-4 pointer-coarse:h-11" disabled={oauth.isPending} onClick={() => oauth.mutate(false)}>
              {pendingBasic ? <Spinner /> : <Link2 aria-hidden />}
              {t('google.connection.connect')}
            </Button>
          </div>
        )}
      </Group>

      {!(g.connected && g.extended_access) && (
        <Group title={t('google.extended.title')} footer={t('google.extended.footer')}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-text-primary">{t('google.extended.body')}</p>
            <ul className="type-footnote flex list-disc flex-col gap-1 pl-5 text-text-secondary">
              <li>{t('google.extended.point1')}</li>
              <li>{t('google.extended.point2')}</li>
            </ul>
            <Button variant="outline" className="self-start pointer-coarse:h-11" disabled={oauth.isPending} onClick={() => oauth.mutate(true)}>
              {pendingExtended ? <Spinner /> : <ShieldPlus aria-hidden />}
              {t('google.extended.grant')}
            </Button>
          </div>
        </Group>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t('google.connection.disconnectConfirm.title')}
        description={<p>{t('google.connection.disconnectConfirm.body')}</p>}
        confirmLabel={t('google.connection.disconnect')}
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function CreateCalendarDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const nameId = useId()
  const selectId = useId()
  const [name, setName] = useState(() => t('google.create.defaultName'))
  const [selectAfter, setSelectAfter] = useState(true)
  const [touched, setTouched] = useState(false)

  const create = useMutation({
    mutationFn: () => api.google.createCalendar(name.trim(), selectAfter),
    onSuccess: (r) => {
      toast.success(t('google.create.created', { name: r.calendar.name }))
      void qc.invalidateQueries({ queryKey: qk.googleCalendars })
      void qc.invalidateQueries({ queryKey: qk.status })
      onOpenChange(false)
    },
  })

  useEffect(() => {
    if (open) {
      setName(t('google.create.defaultName'))
      setTouched(false)
      create.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const nameError = touched && !name.trim() ? t('validation.required') : null
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (name.trim()) create.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="shadow-sheet sm:max-w-md">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="type-headline">{t('google.create.title')}</DialogTitle>
            <DialogDescription className="text-text-secondary">{t('google.create.description')}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(nameError) || undefined}>
            <FieldLabel htmlFor={nameId}>{t('google.create.name')}</FieldLabel>
            <Input
              id={nameId}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(nameError) || undefined}
              className="h-10 pointer-coarse:h-11"
            />
            {nameError && <FieldError>{nameError}</FieldError>}
          </Field>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={selectId} className="min-w-0 flex-1">
              {t('google.create.selectAfter')}
            </label>
            <Switch id={selectId} checked={selectAfter} onCheckedChange={setSelectAfter} />
          </div>
          {create.error && (
            <Alert variant="destructive" className="rounded-xl border-0 bg-danger-soft">
              <TriangleAlert aria-hidden />
              <AlertDescription className="text-text-primary">{msg(create.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="m-0 rounded-none border-0 bg-transparent p-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {t('google.create.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function lockText(cal: GoogleCalendar, allowPrimary: boolean, t: TFunction): string | null {
  // The backend decides the lock reason. Only "primary_locked" may be stale right after the
  // user enabled allow_primary_target; the confirm dialog and the backend check it again.
  if (cal.lock_reason === 'primary_locked') return allowPrimary ? null : t('google.calendars.lock.primary_locked')
  if (cal.lock_reason) return tEnum(t, 'google.calendars.lock', cal.lock_reason)
  if (!cal.selectable) return t('google.calendars.lock.not_writable')
  return null
}

function CalendarsSection({ connected }: { connected: boolean }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const qc = useQueryClient()
  const calendars = useQuery({ queryKey: qk.googleCalendars, queryFn: api.google.calendars, enabled: connected })
  const settings = useQuery({ queryKey: qk.syncSettings, queryFn: api.sync.settings })
  const allowPrimary = settings.data?.allow_primary_target ?? false
  const [createOpen, setCreateOpen] = useState(false)
  const [primaryCandidate, setPrimaryCandidate] = useState<GoogleCalendar | null>(null)

  const select = useMutation({
    mutationFn: (vars: { id: string; confirmPrimary: boolean }) => api.google.setTarget(vars.id, vars.confirmPrimary),
    onSuccess: (r) => {
      toast.success(t('google.calendars.selected', { name: r.target.name }))
      void qc.invalidateQueries({ queryKey: qk.googleCalendars })
      void qc.invalidateQueries({ queryKey: qk.status })
    },
    onError: (e) => toast.error(msg(e)),
  })

  const onSelect = (id: string) => {
    const cal = calendars.data?.calendars.find((c) => c.id === id)
    if (!cal) return
    if (cal.primary) setPrimaryCandidate(cal)
    else select.mutate({ id, confirmPrimary: false })
  }

  const action = (
    <Button variant="ghost" size="sm" className="text-accent-text" disabled={!connected} onClick={() => setCreateOpen(true)}>
      <CalendarPlus aria-hidden />
      {t('google.create.open')}
    </Button>
  )

  let body
  if (!connected) {
    body = <EmptyState icon={<Lock aria-hidden />} title={t('google.calendars.needConnectionTitle')} description={t('google.calendars.needConnectionBody')} />
  } else if (calendars.isPending) {
    body = (
      <div className="flex flex-col gap-3 p-4" aria-hidden>
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
    body = (
      <EmptyState
        icon={<CalendarX2 aria-hidden />}
        title={t('google.calendars.emptyTitle')}
        description={t('google.calendars.emptyBody')}
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <CalendarPlus aria-hidden />
            {t('google.create.open')}
          </Button>
        }
      />
    )
  } else {
    const list = calendars.data.calendars
    const selected = list.find((c) => c.selected)?.id ?? ''
    body = (
      <RadioGroup value={selected} onValueChange={onSelect} aria-label={t('google.calendars.title')} className="gap-0" disabled={select.isPending}>
        {list.map((cal) => (
          <GoogleCalendarRow key={cal.id} cal={cal} lock={lockText(cal, allowPrimary, t)} />
        ))}
      </RadioGroup>
    )
  }

  return (
    <>
      <Group title={t('google.calendars.title')} action={action} footer={t('google.calendars.footer')}>
        {body}
      </Group>
      <CreateCalendarDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={primaryCandidate !== null}
        onOpenChange={(v) => !v && setPrimaryCandidate(null)}
        title={t('google.primary.title')}
        description={
          <>
            <p>{t('google.primary.body1')}</p>
            <p>{t('google.primary.body2')}</p>
          </>
        }
        confirmLabel={t('google.primary.confirm')}
        destructive
        onConfirm={() => {
          if (primaryCandidate) select.mutate({ id: primaryCandidate.id, confirmPrimary: true })
          setPrimaryCandidate(null)
        }}
      />
    </>
  )
}

function GoogleCalendarRow({ cal, lock }: { cal: GoogleCalendar; lock: string | null }) {
  const { t } = useTranslation()
  const inputId = useId()
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'group-row pressable relative flex min-h-(--size-row-min) items-start gap-3 px-4 py-3 [--row-inset:2.75rem]',
        lock ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-fill',
      )}
    >
      <RadioGroupItem id={inputId} value={cal.id} disabled={Boolean(lock)} className="mt-1" aria-describedby={`${inputId}-meta`} />
      <div className={cn('flex min-w-0 flex-1 flex-col gap-1', lock && 'opacity-70')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ColorDot color={cal.color} />
          <span className="font-medium break-words text-text-primary">{cal.name}</span>
          {cal.primary && <StatusBadge tone="warning">{t('calendar.badge.primary')}</StatusBadge>}
          {cal.created_by_app && <StatusBadge tone="accent">{t('calendar.badge.createdByApp')}</StatusBadge>}
          {cal.selected && <StatusBadge tone="success">{t('calendar.badge.selected')}</StatusBadge>}
        </div>
        <div id={`${inputId}-meta`} className="type-footnote flex flex-wrap gap-x-3 gap-y-0.5 text-text-secondary">
          <span>{tEnum(t, 'google.calendars.role', cal.access_role)}</span>
          {lock && (
            <span className="inline-flex items-center gap-1 text-warning">
              <CircleSlash className="size-3.5" aria-hidden />
              {lock}
            </span>
          )}
        </div>
      </div>
    </label>
  )
}

/* ------------------------------------------------------------------ */

export function GooglePage() {
  const { t } = useTranslation()
  useOAuthReturn()
  const status = useStatus()
  const connected = status.data?.google.connected ?? false
  return (
    <>
      <PageHeader title={t('google.title')} description={t('google.description')} />
      <div className="mt-4 grid items-start gap-(--space-section) columns:grid-cols-2 columns:gap-x-6">
        <ConnectionSection />
        <div className="flex flex-col gap-(--space-section)">
          <CalendarsSection connected={connected} />
          <Alert className="rounded-xl border-0 bg-surface shadow-card">
            <Info aria-hidden />
            <AlertTitle className="font-semibold">{t('google.grouping.title')}</AlertTitle>
            <AlertDescription className="text-text-secondary">{t('google.grouping.body')}</AlertDescription>
          </Alert>
        </div>
      </div>
    </>
  )
}
