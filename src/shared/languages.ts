import type { Language, LanguageSetting } from './types'

/** Supported interface languages, each named in its own language. */
export const LANGUAGES: { code: Language; name: string; flag: string }[] = [
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'uk', name: 'Українська', flag: '🇺🇦' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' }
]

const CODES = new Set<string>(LANGUAGES.map((l) => l.code))

/**
 * Resolves the "auto" setting from the system's preferred languages
 * (e.g. ["uk-UA", "ru", "en-US"]); falls back to English.
 */
export function pickLanguage(setting: LanguageSetting | undefined, preferred: readonly string[]): Language {
  if (setting && setting !== 'auto' && CODES.has(setting)) return setting
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (CODES.has(base)) return base as Language
    // Belarusian and Kazakh users usually read Russian
    if (base === 'be' || base === 'kk') return 'ru'
  }
  return 'en'
}
