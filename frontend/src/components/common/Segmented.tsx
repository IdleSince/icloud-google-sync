import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  lang?: string
}

/**
 * iOS-style segmented control built on shadcn's ToggleGroup: a filled track with
 * the selected segment raised on it. Single-select, never empty.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (value: T) => void
  options: Array<SegmentedOption<T>>
  label: string
}) {
  return (
    <ToggleGroup
      type="single"
      spacing={0.5}
      value={value}
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v)
        if (match) onChange(match.value)
      }}
      aria-label={label}
      className="max-w-full flex-wrap rounded-lg bg-fill p-0.5"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          lang={o.lang}
          className="h-7 gap-1.5 rounded-md px-3 text-text-secondary hover:bg-transparent hover:text-text-primary aria-pressed:bg-surface-raised aria-pressed:text-text-primary aria-pressed:shadow-card data-[state=on]:bg-surface-raised data-[state=on]:text-text-primary data-[state=on]:shadow-card pointer-coarse:h-9"
        >
          {o.icon}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
