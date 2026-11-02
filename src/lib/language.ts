import { pickLanguage } from '@shared/languages'
import type { Language, LanguageSetting } from '@shared/types'

/** The language actually used, resolving "auto" from the system. */
export function resolveLanguage(setting: LanguageSetting | undefined): Language {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language]
  return pickLanguage(setting, preferred)
}
