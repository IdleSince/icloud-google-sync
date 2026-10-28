import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import de from '@/locales/de.json'
import en from '@/locales/en.json'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '..')
const apiMd = path.resolve(here, '../../../docs/api.md')

type Tree = { [k: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}

const locales = { de: flatten(de as Tree), en: flatten(en as Tree) }

/** A key exists if present directly or as plural forms (_one/_other). */
function has(map: Map<string, string>, key: string): boolean {
  return map.has(key) || (map.has(`${key}_one`) && map.has(`${key}_other`))
}

function expectEverywhere(keys: string[]) {
  for (const [lang, map] of Object.entries(locales)) {
    const missing = keys.filter((k) => !has(map, k))
    expect(missing, `missing in ${lang}.json`).toEqual([])
  }
}

describe('locale files', () => {
  it('de.json and en.json have identical key sets', () => {
    const deKeys = [...locales.de.keys()].sort()
    const enKeys = [...locales.en.keys()].sort()
    expect(deKeys.filter((k) => !locales.en.has(k)), 'only in de').toEqual([])
    expect(enKeys.filter((k) => !locales.de.has(k)), 'only in en').toEqual([])
  })

  it('has no empty values', () => {
    for (const [lang, map] of Object.entries(locales)) {
      const empty = [...map.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k)
      expect(empty, `empty in ${lang}`).toEqual([])
    }
  })

  it('uses the same interpolation variables in both languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{\{\s*([\w]+)/g)].map((m) => m[1]).sort()
    const mismatched = [...locales.de.keys()].filter((k) => JSON.stringify(vars(locales.de.get(k)!)) !== JSON.stringify(vars(locales.en.get(k) ?? '')))
    expect(mismatched).toEqual([])
  })
})

describe('API codes are translated', () => {
  const md = readFileSync(apiMd, 'utf8')

  it('every error code in the docs/api.md table has errors.<code>', () => {
    const codes = [...md.matchAll(/^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|\s*\d{3}\s*\|/gm)].map((m) => m[1]!)
    expect(codes.length).toBeGreaterThanOrEqual(29)
    expectEverywhere(codes.map((c) => `errors.${c}`))
  })

  it('every run/log message code in docs/api.md has a text', () => {
    const section = md.slice(md.indexOf('Codes that only appear inside run results'), md.indexOf('## Auth'))
    const codes = [...section.matchAll(/`(sync\.[a-z_]+)`/g)].map((m) => m[1]!)
    expect(codes).toContain('sync.deletion_guard_tripped')
    for (const [lang, map] of Object.entries(locales)) {
      const missing = codes.filter((c) => !has(map, `messages.${c}`) && !has(map, `errors.${c}`))
      expect(missing, lang).toEqual([])
    }
  })

  it('synthetic client codes and the generic fallback exist', () => {
    expectEverywhere(['errors.network.unreachable', 'errors.unknown', 'errors.internal.error'])
  })

  it('every enum value from the contract has a label', () => {
    const enums: Record<string, string[]> = {
      'runs.status': ['running', 'success', 'partial', 'failed', 'skipped'],
      'runs.trigger': ['schedule', 'manual', 'dry_run', 'startup'],
      'runs.action': ['create', 'update', 'delete', 'reset_instance', 'skip_delete', 'error'],
      'runs.counts': ['created', 'updated', 'deleted', 'unchanged', 'failed'],
      'logs.level': ['info', 'warning', 'error'],
      'logs.category': ['sync', 'icloud', 'google', 'auth', 'system'],
      'status.icloud': ['ok', 'error', 'unknown'],
      'status.google': ['ok', 'error', 'reauth_required', 'unknown'],
      'calendar.ownership': ['own', 'shared', 'unknown'],
      'calendar.access': ['read', 'read_write', 'unknown'],
      'google.calendars.role': ['owner', 'writer', 'reader', 'freeBusyReader'],
      'google.calendars.lock': ['primary_locked', 'not_writable', 'scope_missing'],
      'icloud.diagnostics.status': ['ok', 'warn', 'fail', 'skipped'],
    }
    const keys = Object.entries(enums).flatMap(([prefix, values]) => values.map((v) => `${prefix}.${v}`))
    expectEverywhere(keys)
  })

  it('every diagnostics step has a title and a text per status, every conclusion a title and body', () => {
    const steps = ['credentials', 'principal', 'calendar_home', 'calendars', 'shared_readable', 'delegation']
    const statuses = ['title', 'ok', 'warn', 'fail', 'skipped']
    const conclusions = ['shared_accessible', 'shared_not_listed', 'shared_not_readable', 'auth_failed', 'unreachable', 'not_configured', 'unknown']
    expectEverywhere([
      ...steps.flatMap((s) => statuses.map((st) => `icloud.diagnostics.steps.${s}.${st}`)),
      ...conclusions.flatMap((c) => [`icloud.diagnostics.conclusion.${c}.title`, `icloud.diagnostics.conclusion.${c}.body`]),
    ])
  })
})

describe('source code', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return name === 'test' ? [] : walk(full)
      return /\.(tsx?)$/.test(name) ? [full] : []
    })
  }
  const files = walk(srcDir)

  it('every literal t("…") / i18nKey used in the code exists in both languages', () => {
    const used = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) used.add(m[1]!)
      for (const m of text.matchAll(/i18nKey="([\w.]+)"/g)) used.add(m[1]!)
    }
    expect(used.size).toBeGreaterThan(200)
    expectEverywhere([...used])
  })

  it('templated keys resolve for every value they are used with', () => {
    expectEverywhere([
      ...['overview', 'icloud', 'google', 'sync', 'logs'].map((k) => `nav.${k}`),
      ...['history', 'errors', 'all', 'stats', 'diagnostics'].map((k) => `logs.tabs.${k}`),
      ...['all', 'success', 'failed'].map((k) => `logs.history.filter.${k}`),
      ...['runs', 'failed', 'created', 'updated', 'deleted'].map((k) => `logs.stats.totals.${k}`),
      ...['created', 'updated', 'deleted', 'failed'].map((k) => `runs.countsShort.${k}`),
      ...['system', 'light', 'dark'].map((k) => `preferences.appearance.${k}`),
      ...['de', 'en'].map((k) => `preferences.language.names.${k}`),
    ])
  })

  it('components contain no raw hex colors (tokens file only)', () => {
    const offenders = files.filter((f) => /\.tsx$/.test(f) && /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/.test(readFileSync(f, 'utf8').replace(/\^#\[0-9a-f\]\{3,8\}\$/g, '')))
    expect(offenders.map((f) => path.relative(srcDir, f))).toEqual([])
  })
})
