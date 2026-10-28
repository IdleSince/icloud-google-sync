/* All user-visible dates, times, numbers and durations go through Intl with the
 * active locale. Nothing here concatenates date parts by hand. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** `2026-11-02` is a calendar date without a zone: format it as-is (UTC) so it
 *  never shifts by a day in western time zones. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value)
}

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(isDateOnly(value) ? `${value}T00:00:00Z` : value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | Date | null | undefined, locale: string, opts?: { seconds?: boolean }): string {
  if (!value) return ''
  if (typeof value === 'string' && isDateOnly(value)) return formatDate(value, locale)
  const date = toDate(value)
  if (!date) return ''
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: opts?.seconds ? 'medium' : 'short',
  }).format(date)
}

export function formatDate(value: string | Date | null | undefined, locale: string, style: 'medium' | 'short' | 'long' = 'medium'): string {
  if (!value) return ''
  const date = toDate(value)
  if (!date) return ''
  const dateOnly = typeof value === 'string' && isDateOnly(value)
  return new Intl.DateTimeFormat(locale, { dateStyle: style, ...(dateOnly ? { timeZone: 'UTC' } : {}) }).format(date)
}

/** Short weekday + day for chart rows, e.g. „Di., 28.10.“ / “Tue, 10/28”. */
export function formatDayShort(value: string, locale: string): string {
  const date = toDate(value)
  if (!date) return value
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(date)
}

export function formatNumber(value: number | null | undefined, locale: string, opts?: Intl.NumberFormatOptions): string {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  return new Intl.NumberFormat(locale, opts).format(value)
}

export function formatPercent(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction)
}

/** 830 ms → „830 ms“, 1830 ms → „1,8 s“, 125000 ms → „2,1 min“. */
export function formatDuration(ms: number | null | undefined, locale: string): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return ''
  if (ms < 1000) {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(Math.round(ms))
  }
  if (ms < 60_000) {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(ms / 1000)
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 1 }).format(ms / 60_000)
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** „in 3 Minuten“, „vor 2 Stunden“, „jetzt“. `now` is injected so a ticking clock can drive it. */
export function formatRelative(value: string | Date | null | undefined, locale: string, now: number = Date.now()): string {
  if (!value) return ''
  const date = toDate(value)
  if (!date) return ''
  let delta = (date.getTime() - now) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) {
      return rtf.format(Math.round(delta), unit)
    }
    delta /= size
  }
  return rtf.format(Math.round(delta), 'year')
}

export function formatList(items: string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items)
}

/** Sharers may come as `mailto:` URIs from CalDAV; show the address only. */
export function displayOwner(owner: string): string {
  return owner.replace(/^mailto:/i, '')
}
