import { useQueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { onUnauthorized, setCsrfToken } from '@/api/client'
import { qk } from '@/api/endpoints'
import { LOGGED_OUT, useSession } from '@/api/hooks'
import { QueryError } from '@/components/common/QueryError'
import { Spinner } from '@/components/ui/spinner'

/** Any 401 from any request → clear the session and go to /login. */
export function UnauthorizedHandler() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    onUnauthorized(() => {
      setCsrfToken(null)
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] })
      qc.setQueryData(qk.session, LOGGED_OUT)
      if (location.pathname !== '/login') {
        navigate('/login', { replace: true, state: { from: location.pathname + location.search } })
      }
    })
    return () => onUnauthorized(null)
  }, [qc, navigate, location])
  return null
}

export function FullScreenSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="size-6 text-text-secondary" />
    </div>
  )
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession()
  const location = useLocation()
  const { t } = useTranslation()
  if (session.isPending) return <FullScreenSpinner />
  if (session.isError) {
    return (
      <div className="safe-x flex min-h-dvh items-center justify-center">
        <div className="w-full max-w-xl">
          <QueryError error={session.error} onRetry={() => void session.refetch()} title={t('auth.sessionFailed')} />
        </div>
      </div>
    )
  }
  if (!session.data.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <>{children}</>
}
