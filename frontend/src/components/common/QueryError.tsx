import { RotateCw, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useMessage } from '@/lib/messages'

/** Error state for a failed query, with a retry. */
export function QueryError({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { t } = useTranslation()
  const msg = useMessage()
  return (
    <Alert variant="destructive" className="rounded-xl border-0 bg-danger-soft px-4 py-3 text-danger">
      <TriangleAlert aria-hidden />
      <AlertTitle className="font-semibold">{title ?? t('common.loadFailed')}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3 text-text-primary">
        <span className="min-w-0 flex-1">{msg(error)}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden />
            {t('common.retry')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
