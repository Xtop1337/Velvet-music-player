import { describe, expect, it } from 'vitest'
import { pickLanguage } from '@shared/languages'
import { mainStrings } from '@shared/mainStrings'
import { de } from '../src/i18n/de'
import { en } from '../src/i18n/en'
import { es } from '../src/i18n/es'
import { fr } from '../src/i18n/fr'
import { ru } from '../src/i18n/ru'
import { uk } from '../src/i18n/uk'

function keys(o: unknown, prefix = ''): string[] {
  if (Array.isArray(o)) return [`${prefix}[${o.length}]`]
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
  return [prefix]
}

describe('languages', () => {
  it('detects the system language', () => {
    expect(pickLanguage('auto', ['uk-UA', 'en-US'])).toBe('uk')
    expect(pickLanguage('auto', ['pl-PL', 'de-DE'])).toBe('de')
    expect(pickLanguage('auto', ['be-BY'])).toBe('ru')
    expect(pickLanguage('auto', ['ja-JP'])).toBe('en')
    expect(pickLanguage('fr', ['ru-RU'])).toBe('fr')
  })
  it('every translation has exactly the same keys as Russian, with no empty strings', () => {
    const base = keys(ru).sort()
    for (const [name, dict] of Object.entries({ en, uk, de, es, fr })) {
      expect(keys(dict).sort(), name).toEqual(base)
      const empty = keys(dict).filter((k) => {
        const v = k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p.replace(/\[\d+\]$/, '')], dict)
        return v === ''
      })
      // only lyrics.source.none is intentionally empty
      expect(empty, name).toEqual(['lyrics.source.none'])
    }
  })
  it('keeps {{placeholders}} intact in every translation', () => {
    const flat = (o: unknown, p = ''): Record<string, string> =>
      Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
        const key = p ? `${p}.${k}` : k
        if (typeof v === 'string') acc[key] = v
        else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(acc, flat(v, key))
        return acc
      }, {})
    const vars = (s: string): string => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',')
    const base = flat(ru)
    for (const [name, dict] of Object.entries({ en, uk, de, es, fr })) {
      const f = flat(dict)
      for (const k of Object.keys(base)) expect(vars(f[k]), `${name}: ${k}`).toBe(vars(base[k]))
    }
  })
  it('has main-process strings for every language', () => {
    for (const l of ['ru', 'en', 'uk', 'de', 'es', 'fr'] as const) expect(mainStrings(l).paused).toBeTruthy()
  })
})
