import { useNow } from '@/hooks/use-now'
import { useLocale } from '@/hooks/use-locale'
import { formatDateTime, formatRelative } from '@/lib/format'

/** Live relative time („in 3 Minuten“) with the absolute time as tooltip. */
export function RelativeTime({ value, live = true }: { value: string; live?: boolean }) {
  const locale = useLocale()
  const now = useNow(live ? 1000 : 60_000)
  const absolute = formatDateTime(value, locale, { seconds: true })
  return (
    <time dateTime={value} title={absolute}>
      {formatRelative(value, locale, now)}
    </time>
  )
}
