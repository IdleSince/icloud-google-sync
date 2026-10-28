import type { TFunction, i18n as I18n } from 'i18next'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, FALLBACK_ERROR_CODE } from '@/api/client'
import type { ApiErrorBody, Params } from '@/api/types'
import { formatList } from './format'

/** Codes are dotted (`icloud.auth_failed`) and map 1:1 to nested locale keys. */
const CODE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i

function prepareParams(params: Params, t: TFunction, locale: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const labels = value.map((v) => {
        const s = String(v)
        return key === 'fields' ? t(`fields.${s}`, { defaultValue: s }) : s
      })
      out[key] = formatList(labels, locale)
    } else if (value === null || value === undefined) {
      out[key] = ''
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value)
    } else {
      out[key] = value
    }
  }
  // Codes whose text depends on a number use i18next plural rules via `count`.
  if (typeof out.retry_after_seconds === 'number' && out.count === undefined) out.count = out.retry_after_seconds
  return out
}

/**
 * Resolves a machine code to text. Lookup order:
 *   messages.<code>  (run results / log events)
 *   errors.<code>    (API error codes)
 *   errors.unknown   (generic fallback that still shows the code for support)
 */
export function translateCode(i18n: I18n, code: string | null | undefined, params: Params = {}): string {
  const t = i18n.t.bind(i18n) as TFunction
  const locale = i18n.language
  const safeCode = code && CODE_PATTERN.test(code) ? code : null
  const values = prepareParams(params, t, locale)
  if (safeCode) {
    for (const ns of ['messages', 'errors'] as const) {
      const key = `${ns}.${safeCode}`
      if (i18n.exists(key, values)) return t(key, values)
    }
  }
  return t('errors.unknown', { code: code ?? FALLBACK_ERROR_CODE })
}

export function errorToBody(error: unknown): ApiErrorBody {
  if (error instanceof ApiError) return { code: error.code, params: error.params }
  return { code: FALLBACK_ERROR_CODE, params: {} }
}

/** Hook form: `const msg = useMessage(); msg(error)` or `msg(code, params)`. */
export function useMessage() {
  const { i18n } = useTranslation()
  return useCallback(
    (input: ApiErrorBody | unknown | string | null | undefined, params?: Params): string => {
      if (typeof input === 'string') return translateCode(i18n, input, params ?? {})
      if (input && typeof input === 'object' && 'code' in input && typeof (input as ApiErrorBody).code === 'string' && !(input instanceof Error)) {
        const body = input as ApiErrorBody
        return translateCode(i18n, body.code, body.params ?? {})
      }
      const body = errorToBody(input)
      return translateCode(i18n, body.code, body.params)
    },
    [i18n],
  )
}

/** Label for an enum value (`runs.status.success`); unknown values fall back to a generic label. */
export function tEnum(t: TFunction, prefix: string, value: string | null | undefined): string {
  const v = value ?? ''
  return t(`${prefix}.${v}`, { defaultValue: t('common.unknownValue', { value: v }) })
}
