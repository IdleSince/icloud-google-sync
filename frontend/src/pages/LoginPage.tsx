import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Cloud, CalendarDays, LogIn, TriangleAlert } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { setCsrfToken } from '@/api/client'
import { api, qk } from '@/api/endpoints'
import { useSession } from '@/api/hooks'
import { FullScreenSpinner } from '@/app/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useMessage } from '@/lib/messages'
import { Segmented } from '@/components/common/Segmented'
import { DEFAULT_LANGUAGE, isLanguage, persistLanguage, SUPPORTED_LANGUAGES } from '@/i18n'

function safeRedirect(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && from !== '/login' ? from : '/'
}

/**
 * Wide: two panes — what the app does on the left, the form on the right.
 * Phone: the same two blocks stacked, form first in reading order after the title.
 */
export function LoginPage() {
  const { t, i18n } = useTranslation()
  const msg = useMessage()
  const session = useSession()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const from = safeRedirect((location.state as { from?: unknown } | null)?.from)
  const userId = useId()
  const passId = useId()
  const errorId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const login = useMutation({
    mutationFn: () => api.auth.login(username.trim(), password),
    onSuccess: (data) => {
      setCsrfToken(data.csrf_token)
      qc.setQueryData(qk.session, data)
      if (data.authenticated) navigate(from, { replace: true })
    },
  })

  if (session.isPending) return <FullScreenSpinner />
  if (session.data?.authenticated) return <Navigate to={from} replace />

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    login.mutate()
  }

  const error = login.error
  const errorText = error ? msg(error) : null

  return (
    <div className="grid min-h-dvh split:grid-cols-[minmax(0,1fr)_minmax(24rem,32rem)]">
      <section className="safe-x material-chrome order-2 flex flex-col justify-center gap-6 border-t border-separator py-10 split:order-1 split:border-t-0 split:border-r split:px-16">
        <div className="flex items-center gap-3 text-text-secondary" aria-hidden>
          <span className="flex size-12 items-center justify-center rounded-xl text-tile-glyph" style={{ backgroundColor: 'var(--color-tile-icloud)' }}>
            <Cloud className="size-6" />
          </span>
          <ArrowRightLeft className="size-5" />
          <span className="flex size-12 items-center justify-center rounded-xl text-tile-glyph" style={{ backgroundColor: 'var(--color-tile-google)' }}>
            <CalendarDays className="size-6" />
          </span>
        </div>
        <div className="flex max-w-[34rem] flex-col gap-3">
          <h2 className="type-title">{t('login.pitch.title')}</h2>
          <p className="type-body text-text-secondary">{t('login.pitch.body')}</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 type-body text-text-secondary">
            <li>{t('login.pitch.point1')}</li>
            <li>{t('login.pitch.point2')}</li>
            <li>{t('login.pitch.point3')}</li>
          </ul>
        </div>
      </section>

      <section className="safe-x order-1 flex flex-col justify-center gap-8 pt-[max(3rem,env(safe-area-inset-top))] pb-10 split:order-2 split:px-12">
        <div className="flex flex-col gap-2">
          <h1 className="type-large-title">{t('app.name')}</h1>
          <p className="type-body text-text-secondary">{t('login.subtitle')}</p>
        </div>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5" aria-describedby={errorText ? errorId : undefined}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={userId}>{t('login.username')}</FieldLabel>
              <Input
                id={userId}
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-11 bg-surface"
                aria-invalid={Boolean(errorText) || undefined}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={passId}>{t('login.password')}</FieldLabel>
              <Input
                id={passId}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 bg-surface"
                aria-invalid={Boolean(errorText) || undefined}
              />
            </Field>
          </FieldGroup>
          {errorText && (
            <Alert id={errorId} variant="destructive" className="rounded-xl border-0 bg-danger-soft">
              <TriangleAlert aria-hidden />
              <AlertDescription className="text-text-primary">{errorText}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" size="lg" className="h-11 type-body" disabled={login.isPending || !username.trim() || !password}>
            {login.isPending ? <Spinner /> : <LogIn aria-hidden />}
            {t('login.submit')}
          </Button>
        </form>
        <Segmented
          value={isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LANGUAGE}
          onChange={(v) => {
            persistLanguage(v)
            void i18n.changeLanguage(v)
          }}
          label={t('preferences.language.label')}
          options={SUPPORTED_LANGUAGES.map((lang) => ({ value: lang, lang, label: t(`preferences.language.names.${lang}`) }))}
        />
      </section>
    </div>
  )
}
