import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CalendarPlus, CalendarX2, CircleSlash, Info, Link2, ListChecks, Lock, PlugZap, ShieldPlus, TriangleAlert, Unplug } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, qk } from '@/api/endpoints'
import { useInvalidatePairs, usePairs, useStatus } from '@/api/hooks'
import type { GoogleCalendar, Pair } from '@/api/types'
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useIsSplit } from '@/hooks/use-media-query'
import { displayOwner } from '@/lib/format'
import { tEnum, useMessage } from '@/lib/messages'
import { pairsWithoutTarget } from '@/lib/pairs'
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

function CreateTargetDialog({ pair, onOpenChange }: { pair: Pair | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const invalidate = useInvalidatePairs()
  const nameId = useId()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)

  const create = useMutation({
    mutationFn: (vars: { pair: Pair; name: string }) => api.pairs.createTarget(vars.pair.id, vars.name),
    onSuccess: (r) => {
      toast.success(t('google.targets.created', { target: r.pair.target?.name ?? '', name: r.pair.source.name }))
      onOpenChange(false)
    },
    onSettled: invalidate,
  })

  // Prefill with the backend's suggestion ("Arbeit (anna@example.com)") each time it opens.
  useEffect(() => {
    if (pair) {
      setName(pair.suggested_target_name)
      setTouched(false)
      create.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.id])

  const nameError = touched && !name.trim() ? t('validation.required') : null
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (pair && name.trim()) create.mutate({ pair, name: name.trim() })
  }

  return (
    <Dialog open={pair !== null} onOpenChange={onOpenChange}>
      <DialogContent className="shadow-sheet sm:max-w-md">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="type-headline">{t('google.targets.createDialog.title')}</DialogTitle>
            <DialogDescription className="text-text-secondary">
              {t('google.targets.createDialog.description', { name: pair?.source.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(nameError) || undefined}>
            <FieldLabel htmlFor={nameId}>{t('google.targets.createDialog.name')}</FieldLabel>
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
          {create.error && (
            <Alert variant="destructive" className="rounded-xl border-0 bg-danger-soft">
              <TriangleAlert aria-hidden />
              <AlertDescription className="text-text-primary">{msg(create.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="m-0 rounded-none border-0 bg-transparent p-0">
            <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="pointer-coarse:h-11" disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {t('google.targets.createDialog.submit')}
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

/** Which pair writes into `cal`, as text — or null when it is free. */
function usedByText(cal: GoogleCalendar, pairNames: Map<number, string>, t: TFunction): string | null {
  if (cal.used_by_pair === null) return null
  const name = pairNames.get(cal.used_by_pair)
  return name ? t('google.calendars.usedBy', { name }) : t('google.calendars.usedByUnknown')
}

function useGoogleCalendars(connected: boolean) {
  return useQuery({ queryKey: qk.googleCalendars, queryFn: api.google.calendars, enabled: connected })
}

function ChooseTargetSheet({ pair, pairNames, onClose }: { pair: Pair | null; pairNames: Map<number, string>; onClose: () => void }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const split = useIsSplit()
  const invalidate = useInvalidatePairs()
  const calendars = useGoogleCalendars(pair !== null)
  const settings = useQuery({ queryKey: qk.syncSettings, queryFn: api.sync.settings })
  const allowPrimary = settings.data?.allow_primary_target ?? false
  // The pick belongs to one pair; for any other pair the current target is preselected.
  const [picked, setPicked] = useState<{ pairId: number; calendarId: string } | null>(null)
  const choice = picked && picked.pairId === pair?.id ? picked.calendarId : (pair?.target?.id ?? '')
  const setChoice = (calendarId: string) => pair && setPicked({ pairId: pair.id, calendarId })
  const [confirmPrimary, setConfirmPrimary] = useState(false)
  const close = () => {
    setPicked(null)
    onClose()
  }

  const select = useMutation({
    mutationFn: (vars: { pair: Pair; calendarId: string; confirmPrimary: boolean }) =>
      api.pairs.setTarget(vars.pair.id, vars.calendarId, vars.confirmPrimary),
    onSuccess: (r) => {
      toast.success(t('google.targets.set', { target: r.pair.target?.name ?? '', name: r.pair.source.name }))
      close()
    },
    onError: (e) => toast.error(msg(e)),
    onSettled: invalidate,
  })

  const list = calendars.data?.calendars ?? []
  const chosen = list.find((c) => c.id === choice)
  const unchanged = choice === (pair?.target?.id ?? '')
  const apply = () => {
    if (!pair || !chosen) return
    if (chosen.primary) setConfirmPrimary(true)
    else select.mutate({ pair, calendarId: chosen.id, confirmPrimary: false })
  }

  let body
  if (calendars.isPending) {
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
  } else if (list.length === 0) {
    body = <EmptyState icon={<CalendarX2 aria-hidden />} title={t('google.calendars.emptyTitle')} description={t('google.calendars.emptyBody')} />
  } else {
    body = (
      <RadioGroup value={choice} onValueChange={setChoice} aria-label={t('google.targets.chooseDialog.title')} className="gap-0" disabled={select.isPending}>
        {list.map((cal) => {
          const current = pair?.target?.id === cal.id
          // A calendar that already belongs to another pair is never choosable.
          const usedElsewhere = cal.used_by_pair !== null && cal.used_by_pair !== pair?.id ? usedByText(cal, pairNames, t) : null
          return (
            <GoogleCalendarRow
              key={cal.id}
              cal={cal}
              lock={usedElsewhere ?? lockText(cal, allowPrimary, t)}
              badge={current ? <StatusBadge tone="success">{t('google.targets.current')}</StatusBadge> : null}
              selectable
            />
          )
        })}
      </RadioGroup>
    )
  }

  return (
    <>
      <Sheet open={pair !== null} onOpenChange={(v) => !v && close()}>
        {/* Wide: side panel next to the page. Phone: bottom sheet. Same pattern as the run details. */}
        <SheetContent
          side={split ? 'right' : 'bottom'}
          className={cn(
            'gap-0 bg-grouped shadow-sheet',
            split ? 'w-[min(32rem,100dvw)] sm:max-w-none' : 'max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <SheetHeader className="px-4 pt-5">
            <SheetTitle className="type-title">{t('google.targets.chooseDialog.title')}</SheetTitle>
            <SheetDescription className="text-text-secondary">
              {t('google.targets.chooseDialog.description', { name: pair?.source.name ?? '' })}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-(--space-section) overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
            <Group>{body}</Group>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-separator px-4 py-3">
            <Button variant="outline" className="pointer-coarse:h-11" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button className="pointer-coarse:h-11" disabled={!chosen || unchanged || select.isPending} onClick={apply}>
              {select.isPending && <Spinner />}
              {t('google.targets.chooseDialog.submit')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmPrimary}
        onOpenChange={setConfirmPrimary}
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
          if (pair && chosen) select.mutate({ pair, calendarId: chosen.id, confirmPrimary: true })
          setConfirmPrimary(false)
        }}
      />
    </>
  )
}

function PairTargetRow({ pair, busy, onCreate, onChoose }: { pair: Pair; busy: boolean; onCreate: () => void; onChoose: () => void }) {
  const { t } = useTranslation()
  return (
    <li className="group-row relative flex min-h-(--size-row-min) flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-[min(14rem,100%)] flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-words text-text-primary">{pair.source.name}</span>
          {!pair.enabled && <StatusBadge tone="neutral">{t('pairs.pausedBadge')}</StatusBadge>}
        </div>
        {pair.source.owner && <span className="type-footnote text-text-secondary">{t('calendar.ownerValue', { owner: displayOwner(pair.source.owner) })}</span>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ArrowRight className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <span className="sr-only">{t('pairs.to')}</span>
          {pair.target ? (
            <>
              <span className="break-words text-text-primary">{pair.target.name}</span>
              {pair.target.is_primary && <StatusBadge tone="warning">{t('calendar.badge.primary')}</StatusBadge>}
            </>
          ) : (
            <StatusBadge tone="warning">{t('google.targets.none')}</StatusBadge>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="pointer-coarse:h-11" disabled={busy} aria-label={t('google.targets.createLabel', { name: pair.source.name })} onClick={onCreate}>
          <CalendarPlus aria-hidden />
          {t('google.targets.create')}
        </Button>
        <Button variant="ghost" className="text-accent-text pointer-coarse:h-11" disabled={busy} aria-label={t('google.targets.chooseLabel', { name: pair.source.name })} onClick={onChoose}>
          <ListChecks aria-hidden />
          {t('google.targets.choose')}
        </Button>
      </div>
    </li>
  )
}

function TargetsSection({ connected }: { connected: boolean }) {
  const { t } = useTranslation()
  const msg = useMessage()
  const pairs = usePairs()
  const invalidate = useInvalidatePairs()
  const [createFor, setCreateFor] = useState<Pair | null>(null)
  const [chooseFor, setChooseFor] = useState<Pair | null>(null)
  const pairNames = new Map((pairs.data ?? []).map((p) => [p.id, p.source.name]))
  const missing = pairsWithoutTarget(pairs.data ?? [])

  // Sequential, like "sync all shared calendars" on the iCloud page: one toast at the end.
  const createMissing = useMutation({
    mutationFn: async (list: Pair[]) => {
      let created = 0
      const errors: unknown[] = []
      for (const pair of list) {
        try {
          await api.pairs.createTarget(pair.id)
          created += 1
        } catch (e) {
          errors.push(e)
        }
      }
      return { created, errors }
    },
    onSuccess: ({ created, errors }) => {
      if (errors.length === 0) toast.success(t('google.targets.createdMissing', { count: created }))
      else if (created > 0)
        toast.warning(t('google.targets.createdMissing', { count: created }), { description: t('google.targets.createMissingFailed', { count: errors.length }) })
      else toast.error(t('google.targets.createMissingFailed', { count: errors.length }), { description: msg(errors[0]) })
    },
    onSettled: invalidate,
  })

  const action =
    connected && missing.length > 1 ? (
      <Button variant="ghost" size="sm" className="text-accent-text" disabled={createMissing.isPending} onClick={() => createMissing.mutate(missing)}>
        {createMissing.isPending ? <Spinner /> : <CalendarPlus aria-hidden />}
        {t('google.targets.createMissing')}
      </Button>
    ) : undefined

  let body
  if (!connected) {
    body = <EmptyState icon={<Lock aria-hidden />} title={t('google.calendars.needConnectionTitle')} description={t('google.calendars.needConnectionBody')} />
  } else if (pairs.isPending) {
    body = (
      <div className="flex flex-col gap-3 p-4" aria-hidden>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    )
  } else if (pairs.isError) {
    body = (
      <div className="p-3">
        <QueryError error={pairs.error} onRetry={() => void pairs.refetch()} />
      </div>
    )
  } else if (pairs.data.length === 0) {
    body = (
      <EmptyState
        icon={<CalendarX2 aria-hidden />}
        title={t('google.targets.emptyTitle')}
        description={t('google.targets.emptyBody')}
        action={
          <Button asChild variant="outline" className="pointer-coarse:h-11">
            <Link to="/icloud">{t('google.targets.emptyAction')}</Link>
          </Button>
        }
      />
    )
  } else {
    body = (
      <ul aria-label={t('google.targets.title')} aria-busy={createMissing.isPending || undefined}>
        {pairs.data.map((pair) => (
          <PairTargetRow
            key={pair.id}
            pair={pair}
            busy={createMissing.isPending}
            onCreate={() => setCreateFor(pair)}
            onChoose={() => setChooseFor(pair)}
          />
        ))}
      </ul>
    )
  }

  return (
    <>
      <Group id="google-targets" title={t('google.targets.title')} action={action} footer={t('google.targets.footer')}>
        {body}
      </Group>
      <CreateTargetDialog pair={createFor} onOpenChange={(v) => !v && setCreateFor(null)} />
      <ChooseTargetSheet pair={chooseFor} pairNames={pairNames} onClose={() => setChooseFor(null)} />
    </>
  )
}

/** Read-only overview of the Google account's calendars and which pair uses each. */
function CalendarsSection({ connected }: { connected: boolean }) {
  const { t } = useTranslation()
  const calendars = useGoogleCalendars(connected)
  const pairs = usePairs()
  const settings = useQuery({ queryKey: qk.syncSettings, queryFn: api.sync.settings })
  const allowPrimary = settings.data?.allow_primary_target ?? false
  const pairNames = new Map((pairs.data ?? []).map((p) => [p.id, p.source.name]))

  if (!connected) return null

  let body
  if (calendars.isPending) {
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
    body = <EmptyState icon={<CalendarX2 aria-hidden />} title={t('google.calendars.emptyTitle')} description={t('google.calendars.emptyBody')} />
  } else {
    body = (
      <ul aria-label={t('google.calendars.title')}>
        {calendars.data.calendars.map((cal) => {
          const usedBy = usedByText(cal, pairNames, t)
          return (
            <GoogleCalendarRow
              key={cal.id}
              cal={cal}
              lock={usedBy ? null : lockText(cal, allowPrimary, t)}
              badge={usedBy ? <StatusBadge tone="success">{usedBy}</StatusBadge> : null}
            />
          )
        })}
      </ul>
    )
  }

  return (
    <Group title={t('google.calendars.title')} footer={t('google.calendars.footer')}>
      {body}
    </Group>
  )
}

interface GoogleCalendarRowProps {
  cal: GoogleCalendar
  lock: string | null
  badge: ReactNode
  /** Inside the choose sheet the row is a radio option; in the overview it is plain text. */
  selectable?: boolean
}

function GoogleCalendarRow({ cal, lock, badge, selectable }: GoogleCalendarRowProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const content = (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', selectable && lock && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ColorDot color={cal.color} />
        <span className="font-medium break-words text-text-primary">{cal.name}</span>
        {cal.primary && <StatusBadge tone="warning">{t('calendar.badge.primary')}</StatusBadge>}
        {cal.created_by_app && <StatusBadge tone="accent">{t('calendar.badge.createdByApp')}</StatusBadge>}
        {badge}
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
  )
  if (!selectable) {
    return <li className="group-row relative flex min-h-(--size-row-min) items-start gap-3 px-4 py-3">{content}</li>
  }
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'group-row pressable relative flex min-h-(--size-row-min) items-start gap-3 px-4 py-3 [--row-inset:2.75rem]',
        lock ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-fill',
      )}
    >
      <RadioGroupItem id={inputId} value={cal.id} disabled={Boolean(lock)} className="mt-1" aria-describedby={`${inputId}-meta`} />
      {content}
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
          <TargetsSection connected={connected} />
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
