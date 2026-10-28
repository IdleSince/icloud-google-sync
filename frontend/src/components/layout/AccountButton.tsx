import { CircleUserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PreferencesSheet } from './PreferencesSheet'

/** Phone-only entry to appearance, language and logout. 44px target. */
export function AccountButton() {
  const { t } = useTranslation()
  return (
    <PreferencesSheet
      trigger={
        <Button variant="ghost" size="icon-lg" className="size-11 rounded-full text-accent-text" aria-label={t('preferences.open')}>
          <CircleUserRound className="size-7" aria-hidden />
        </Button>
      }
    />
  )
}
