import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resolveLanguage } from '@renderer/lib/language'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ru } from './ru'
import { uk } from './uk'

void i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
    uk: { translation: uk },
    de: { translation: de },
    es: { translation: es },
    fr: { translation: fr }
  },
  // until settings load, follow the system language
  lng: resolveLanguage('auto'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  showSupportNotice: false
})

export default i18n
