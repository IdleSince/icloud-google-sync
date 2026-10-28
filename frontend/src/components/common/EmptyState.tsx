import type { ReactNode } from 'react'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="gap-3 border-0 px-4 py-8">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-fill text-text-secondary">
          {icon}
        </EmptyMedia>
        <EmptyTitle className="type-headline">{title}</EmptyTitle>
        {description && <EmptyDescription className="text-text-secondary">{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
