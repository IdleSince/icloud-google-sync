import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDate, formatDateTime, formatDuration, formatList, formatNumber, formatRelative } from '@/lib/format'

afterEach(() => vi.restoreAllMocks())

describe('format helpers use Intl with the given locale', () => {
  it('numbers', () => {
    expect(formatNumber(1234567, 'de')).toBe(new Intl.NumberFormat('de').format(1234567))
    expect(formatNumber(1234567, 'en')).toBe(new Intl.NumberFormat('en').format(1234567))
    expect(formatNumber(1234567, 'de')).not.toBe(formatNumber(1234567, 'en'))
  })

  it('date-times', () => {
    const iso = '2026-10-28T09:00:00Z'
    expect(formatDateTime(iso, 'de')).toBe(new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)))
    expect(formatDateTime(iso, 'en')).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)))
  })

  it('date-only values never shift a day', () => {
    expect(formatDate('2026-11-02', 'en')).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-11-02T00:00:00Z')))
    expect(formatDateTime('2026-11-02', 'de')).toBe(formatDate('2026-11-02', 'de'))
  })

  it('relative time via Intl.RelativeTimeFormat', () => {
    const now = Date.parse('2026-10-28T09:00:00Z')
    expect(formatRelative('2026-10-28T09:03:00Z', 'de', now)).toBe(new Intl.RelativeTimeFormat('de', { numeric: 'auto' }).format(3, 'minute'))
    expect(formatRelative('2026-10-28T07:00:00Z', 'en', now)).toBe(new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-2, 'hour'))
    expect(formatRelative('2026-10-28T09:00:20Z', 'en', now)).toBe(new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(20, 'second'))
  })

  it('durations via Intl.NumberFormat units', () => {
    expect(formatDuration(830, 'de')).toBe(new Intl.NumberFormat('de', { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(830))
    expect(formatDuration(1830, 'de')).toBe(
      new Intl.NumberFormat('de', { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(1.83),
    )
  })

  it('lists via Intl.ListFormat', () => {
    expect(formatList(['a', 'b', 'c'], 'de')).toBe(new Intl.ListFormat('de', { style: 'long', type: 'conjunction' }).format(['a', 'b', 'c']))
  })

  it('calls Intl constructors rather than formatting by hand', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
    formatDateTime('2026-10-28T09:00:00Z', 'en')
    expect(spy).toHaveBeenCalledWith('en', expect.anything())
  })

  it('handles empty and invalid input', () => {
    expect(formatDateTime(null, 'de')).toBe('')
    expect(formatDateTime('not a date', 'de')).toBe('')
    expect(formatNumber(undefined, 'de')).toBe('')
  })
})
