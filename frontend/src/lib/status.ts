import type { GoogleHealth, ICloudHealth, LogLevel, RunStatus } from '@/api/types'
import type { Tone } from '@/components/common/StatusBadge'

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'accent',
  success: 'success',
  partial: 'warning',
  failed: 'danger',
  skipped: 'neutral',
}

export const ICLOUD_TONE: Record<ICloudHealth, Tone> = {
  ok: 'success',
  error: 'danger',
  unknown: 'neutral',
}

export const GOOGLE_TONE: Record<GoogleHealth, Tone> = {
  ok: 'success',
  error: 'danger',
  reauth_required: 'warning',
  unknown: 'neutral',
}

export const LOG_LEVEL_TONE: Record<LogLevel, Tone> = {
  info: 'neutral',
  warning: 'warning',
  error: 'danger',
}

export function toneOf<K extends string>(map: Record<K, Tone>, key: string): Tone {
  return (map as Record<string, Tone>)[key] ?? 'neutral'
}
