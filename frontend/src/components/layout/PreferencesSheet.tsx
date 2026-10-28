import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useIsSplit } from '@/hooks/use-media-query'
import { PreferencesPanel } from './PreferencesPanel'

/**
 * The trigger sits in the sidebar footer (wide) or top-right of the page (phone).
 * Wide: the sheet slides out from the left, next to its trigger (spatial consistency).
 * Phone: a bottom sheet, within thumb reach.
 */
export function PreferencesSheet({ trigger }: { trigger: ReactNode }) {
  const { t } = useTranslation()
  const split = useIsSplit()
  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side={split ? 'left' : 'bottom'}
        className={
          split
            ? 'w-[min(26rem,100dvw)] gap-0 bg-grouped shadow-sheet sm:max-w-none'
            : 'max-h-[90dvh] gap-0 rounded-t-2xl bg-grouped pb-[env(safe-area-inset-bottom)] shadow-sheet'
        }
      >
        <SheetHeader className="px-4 pt-5">
          <SheetTitle className="type-title">{t('preferences.title')}</SheetTitle>
          <SheetDescription className="text-text-secondary">{t('preferences.description')}</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto overscroll-contain px-4 pt-2 pb-6">
          <PreferencesPanel />
        </div>
      </SheetContent>
    </Sheet>
  )
}
