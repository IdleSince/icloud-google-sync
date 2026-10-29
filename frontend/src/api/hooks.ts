import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMessage } from '@/lib/messages'
import { ApiError, setCsrfToken } from './client'
import { api, qk } from './endpoints'
import type { Pair, Session } from './types'

export const LOGGED_OUT: Session = { authenticated: false, username: null, csrf_token: null }

export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: async () => {
      const session = await api.auth.session()
      setCsrfToken(session.authenticated ? session.csrf_token : null)
      return session
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
}

/** Status polls every 10 s, every 2 s while a run is in progress. */
export function useStatus() {
  const query = useQuery({
    queryKey: qk.status,
    queryFn: api.status,
    refetchInterval: (q) => (q.state.data?.sync.running ? 2000 : 10_000),
  })

  // When a run finishes, everything derived from runs is stale.
  const qc = useQueryClient()
  const wasRunning = useRef(false)
  const running = query.data?.sync.running ?? false
  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: qk.runsAll })
      void qc.invalidateQueries({ queryKey: qk.logsAll })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['sync', 'run'] })
    }
    wasRunning.current = running
  }, [running, qc])

  return query
}

/** Everything that shows pairs or which calendar belongs to which pair. */
export function useInvalidatePairs() {
  const qc = useQueryClient()
  return useCallback(() => {
    for (const queryKey of [qk.status, qk.pairs, qk.icloudCalendars, qk.googleCalendars]) void qc.invalidateQueries({ queryKey })
  }, [qc])
}

export function usePairs() {
  return useQuery({ queryKey: qk.pairs, queryFn: api.pairs.list, select: (r) => r.pairs })
}

/** Pair id → iCloud calendar name, for log entries and runs that carry `pair_id`. */
export function usePairNames(): Map<number, string> {
  const status = useStatus()
  const pairs = status.data?.pairs
  return useMemo(() => new Map((pairs ?? []).map((p) => [p.id, p.source.name])), [pairs])
}

/** Pause or resume one pair. */
export function useSetPairEnabled() {
  const { t } = useTranslation()
  const msg = useMessage()
  const invalidate = useInvalidatePairs()
  return useMutation({
    mutationFn: (vars: { pair: Pair; enabled: boolean }) => api.pairs.setEnabled(vars.pair.id, vars.enabled),
    onSuccess: ({ pair }) => {
      toast.success(pair.enabled ? t('pairs.resumed', { name: pair.source.name }) : t('pairs.paused', { name: pair.source.name }))
    },
    onError: (e) => toast.error(msg(e)),
    onSettled: invalidate,
  })
}

export function useStartRun() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const msg = useMessage()
  return useMutation({
    /** Without `pair`, every enabled pair gets its own run. */
    mutationFn: (vars: { dryRun: boolean; allowMassDeletion?: boolean; pair?: Pair }) =>
      api.sync.startRun(vars.dryRun, vars.allowMassDeletion ?? false, vars.pair?.id),
    onSuccess: (_data, vars) => {
      if (vars.dryRun) toast.success(t('sync.run.startedDry'))
      else if (vars.pair) toast.success(t('sync.run.startedPair', { name: vars.pair.source.name }))
      else toast.success(t('sync.run.started'))
      void qc.invalidateQueries({ queryKey: qk.status })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'sync.already_running') toast.info(msg(error))
      else toast.error(msg(error))
      void qc.invalidateQueries({ queryKey: qk.status })
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.auth.logout,
    onSettled: () => {
      setCsrfToken(null)
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] })
      qc.setQueryData(qk.session, LOGGED_OUT)
    },
  })
}
