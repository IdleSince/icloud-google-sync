import { cn } from '@/lib/utils'

/** Calendar color from the API (data, not a design value). Decorative. */
export function ColorDot({ color, className }: { color: string | null; className?: string }) {
  const safe = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined
  return (
    <span
      aria-hidden
      className={cn('inline-block size-3 shrink-0 rounded-full bg-text-tertiary shadow-[inset_0_0_0_1px_var(--color-separator)]', className)}
      style={safe ? { backgroundColor: safe } : undefined}
    />
  )
}
