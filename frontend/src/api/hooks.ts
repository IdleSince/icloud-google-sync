import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMessage } from '@/lib/messages'
import { ApiError, setCsrfToken } from './client'
import { api, qk } from './endpoints'
import type { Session } from './types'

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

export function useStartRun() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const msg = useMessage()
  return useMutation({
    mutationFn: (vars: { dryRun: boolean; allowMassDeletion?: boolean }) =>
      api.sync.startRun(vars.dryRun, vars.allowMassDeletion ?? false),
    onSuccess: (_data, vars) => {
      toast.success(vars.dryRun ? t('sync.run.startedDry') : t('sync.run.started'))
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
