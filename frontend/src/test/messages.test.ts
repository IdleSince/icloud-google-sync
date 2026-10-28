import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { translateCode } from '@/lib/messages'

beforeAll(async () => {
  await i18n.changeLanguage('de')
})

describe('translateCode', () => {
  it('translates API error codes', () => {
    expect(translateCode(i18n, 'icloud.auth_failed')).toBe(i18n.t('errors.icloud.auth_failed'))
  })

  it('prefers run messages over errors', () => {
    expect(translateCode(i18n, 'sync.deletion_guard_tripped')).toBe(i18n.t('messages.sync.deletion_guard_tripped'))
  })

  it('uses plural rules for retry_after_seconds', () => {
    expect(translateCode(i18n, 'auth.rate_limited', { retry_after_seconds: 1 })).toContain('1 Sekunde erneut')
    expect(translateCode(i18n, 'auth.rate_limited', { retry_after_seconds: 30 })).toContain('30 Sekunden')
  })

  it('formats field lists with Intl.ListFormat and translated names', () => {
    const text = translateCode(i18n, 'validation.invalid', { fields: ['apple_id', 'app_password'] })
    expect(text).toContain(new Intl.ListFormat('de', { style: 'long', type: 'conjunction' }).format(['Apple-ID', 'App-spezifisches Passwort']))
  })

  it('falls back to a generic message for unknown codes', () => {
    expect(translateCode(i18n, 'foo.bar_baz')).toBe(i18n.t('errors.unknown', { code: 'foo.bar_baz' }))
    expect(translateCode(i18n, null)).toBe(i18n.t('errors.unknown', { code: 'internal.error' }))
  })

  it('switches language', async () => {
    await i18n.changeLanguage('en')
    expect(translateCode(i18n, 'sync.already_running')).toBe('A sync is already running.')
    await i18n.changeLanguage('de')
  })
})
