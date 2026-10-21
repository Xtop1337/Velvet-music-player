import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { ru } from './ru'

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: 'ru',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  showSupportNotice: false
})

export default i18n
