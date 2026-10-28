import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Metric({ value, label, tone, className }: { value: ReactNode; label: ReactNode; tone?: 'success' | 'accent' | 'danger'; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span
        className={cn(
          'type-metric',
          tone === 'success' && 'text-success',
          tone === 'accent' && 'text-accent-text',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value}
      </span>
      <span className="type-footnote text-text-secondary">{label}</span>
    </div>
  )
}
