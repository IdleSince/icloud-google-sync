import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral'

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent-text',
  neutral: 'bg-fill text-text-secondary',
}

export function StatusBadge({ tone, children, icon, className }: { tone: Tone; children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('h-auto min-h-5 rounded-sm px-2 py-0.5 type-caption font-semibold whitespace-normal', TONE_CLASS[tone], className)}
    >
      {icon}
      {children}
    </Badge>
  )
}
