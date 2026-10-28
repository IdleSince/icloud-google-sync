import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

interface GroupProps {
  title?: ReactNode
  /** Footer text under the group, like iOS section footers. */
  footer?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}

/** iOS/macOS "inset grouped" section: small heading, rounded surface, footer note. */
export function Group({ title, footer, action, children, className, id }: GroupProps) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)} aria-labelledby={headingId}>
      {(title || action) && (
        <div className="flex min-h-7 flex-wrap items-end justify-between gap-x-4 gap-y-1 px-4">
          {title && (
            <h2 id={headingId} className="type-footnote font-semibold text-text-secondary">
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      <Card className="gap-0 rounded-xl bg-surface py-0 shadow-card ring-0">{children}</Card>
      {footer && <div className="type-footnote px-4 text-text-secondary">{footer}</div>}
    </section>
  )
}

interface RowProps {
  label?: ReactNode
  description?: ReactNode
  /** Trailing control or value. Wraps under the label when space runs out. */
  children?: ReactNode
  leading?: ReactNode
  className?: string
  htmlFor?: string
  /** Separator inset (start of text); grows when there is a leading icon. */
  inset?: 'text' | 'icon'
}

/** One row of a Group. Label and control share a flexible line — no fixed label width. */
export function Row({ label, description, children, leading, className, htmlFor, inset = 'text' }: RowProps) {
  const LabelTag = htmlFor ? 'label' : 'div'
  return (
    <div
      className={cn(
        'group-row relative flex min-h-(--size-row-min-fine) flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 pointer-coarse:min-h-(--size-row-min)',
        inset === 'icon' && '[--row-inset:3.25rem]',
        className,
      )}
    >
      {leading && <div className="flex shrink-0 items-center">{leading}</div>}
      {(label || description) && (
        <div className="flex min-w-[min(12rem,100%)] flex-1 flex-col gap-0.5">
          {label && (
            <LabelTag htmlFor={htmlFor} className="type-body font-normal text-text-primary">
              {label}
            </LabelTag>
          )}
          {description && <div className="type-footnote text-text-secondary">{description}</div>}
        </div>
      )}
      {children !== undefined && <div className="flex max-w-full shrink-0 items-center gap-2 text-text-secondary">{children}</div>}
    </div>
  )
}
