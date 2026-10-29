import type { DiscoveredCalendar, Pair } from '@/api/types'

/* Pure rules around pairs (one iCloud calendar → one Google calendar), shared by
 * the pages and the navigation badges so they never disagree. */

/** A pair takes part in a run when it is enabled and has a target. */
export function isSyncable(pair: Pair): boolean {
  return pair.enabled && pair.target !== null
}

/** The "sync now" button makes sense when at least one pair would run. */
export function canSync(pairs: Pair[]): boolean {
  return pairs.some(isSyncable)
}

/** Enabled pairs without a target block a complete setup. */
export function everyEnabledPairHasTarget(pairs: Pair[]): boolean {
  return pairs.length > 0 && pairs.every((p) => !p.enabled || p.target !== null)
}

export function pairsWithoutTarget(pairs: Pair[]): Pair[] {
  return pairs.filter((p) => p.target === null)
}

/** Calendars that hold events and can be read may be synchronized. */
export function isPairable(cal: DiscoveredCalendar): boolean {
  return cal.supports_events && cal.readable
}

/** Candidates for "sync all shared calendars": shared, pairable, not yet paired. */
export function sharedCalendarsToAdd(calendars: DiscoveredCalendar[]): DiscoveredCalendar[] {
  return calendars.filter((c) => c.ownership === 'shared' && isPairable(c) && c.pair_id === null)
}

/** Pairs whose last run was held back by the deletion guard. */
export function guardTrippedPairs(pairs: Pair[]): Pair[] {
  return pairs.filter((p) => p.last_run?.message?.code === 'sync.deletion_guard_tripped')
}
