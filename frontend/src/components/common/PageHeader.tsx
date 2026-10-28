import type { ReactNode } from 'react'
import { AccountButton } from '@/components/layout/AccountButton'

/** Large title + description. On phones the account button sits top-right (the
 *  sidebar holds it on wide screens). */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 pt-[max(1rem,env(safe-area-inset-top))] pb-2 split:pt-10">
      <div className="flex items-start gap-3">
        <h1 className="type-large-title min-w-0 flex-1 text-balance">{title}</h1>
        <div className="split:hidden">
          <AccountButton />
        </div>
      </div>
      {(description || actions) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {description && <p className="max-w-[65ch] min-w-0 flex-1 basis-80 type-body text-text-secondary">{description}</p>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
    </header>
  )
}
