import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLogout, useSession } from '@/api/hooks'
import { Group, Row } from '@/components/common/Group'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/common/Segmented'
import { DEFAULT_LANGUAGE, isLanguage, persistLanguage, SUPPORTED_LANGUAGES } from '@/i18n'
import { useTheme, type ThemePreference } from '@/theme/theme-context'

const THEMES: Array<{ value: ThemePreference; icon: typeof Sun }> = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
]

/** Appearance, language and account — shared by the phone sheet and the desktop sidebar sheet. */
export function PreferencesPanel({ onLoggedOut }: { onLoggedOut?: () => void }) {
  const { t, i18n } = useTranslation()
  const { preference, setPreference } = useTheme()
  const session = useSession()
  const logout = useLogout()
  const current = i18n.resolvedLanguage ?? i18n.language

  return (
    <div className="flex flex-col gap-6">
      <Group title={t('preferences.appearance.title')}>
        <Row label={t('preferences.appearance.label')}>
          <Segmented
            value={preference}
            onChange={setPreference}
            label={t('preferences.appearance.label')}
            options={THEMES.map(({ value, icon: Icon }) => ({ value, icon: <Icon aria-hidden />, label: t(`preferences.appearance.${value}`) }))}
          />
        </Row>
      </Group>

      <Group title={t('preferences.language.title')}>
        <Row label={t('preferences.language.label')}>
          <Segmented
            value={isLanguage(current) ? current : DEFAULT_LANGUAGE}
            onChange={(v) => {
              persistLanguage(v)
              void i18n.changeLanguage(v)
            }}
            label={t('preferences.language.label')}
            options={SUPPORTED_LANGUAGES.map((lang) => ({ value: lang, lang, label: t(`preferences.language.names.${lang}`) }))}
          />
        </Row>
      </Group>

      <Group title={t('preferences.account.title')}>
        <Row label={t('preferences.account.signedInAs')}>
          <span className="break-all text-text-primary">{session.data?.username ?? ''}</span>
        </Row>
        <Row>
          <Button
            variant="ghost"
            className="-mx-2.5 text-danger hover:bg-danger-soft hover:text-danger pointer-coarse:h-11"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSettled: onLoggedOut })}
          >
            <LogOut aria-hidden />
            {t('auth.logout')}
          </Button>
        </Row>
      </Group>
    </div>
  )
}
