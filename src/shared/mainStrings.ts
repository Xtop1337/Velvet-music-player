import type { Language } from './types'

/** The few strings shown outside the React UI: Discord activity, tray menu, notifications. */
export interface MainStrings {
  unknownArtist: string
  unknownTrack: string
  paused: string
  /** small badge in Discord while playing */
  playing: string
  openOn: string
  play: string
  pause: string
  next: string
  prev: string
  show: string
  mini: string
  quit: string
  nothing: string
  liked: string
  close: string
}

const STRINGS: Record<Language, MainStrings> = {
  ru: {
    unknownArtist: 'Неизвестный исполнитель',
    unknownTrack: 'Без названия',
    paused: 'Пауза',
    playing: 'Играет',
    openOn: 'Открыть в',
    play: 'Играть',
    pause: 'Пауза',
    next: 'Следующий',
    prev: 'Предыдущий',
    show: 'Открыть Velvet',
    mini: 'Мини-плеер',
    quit: 'Выход',
    nothing: 'Ничего не играет',
    liked: 'Избранное',
    close: 'Закрыть'
  },
  en: {
    unknownArtist: 'Unknown artist',
    unknownTrack: 'Untitled',
    paused: 'Paused',
    playing: 'Playing',
    openOn: 'Open on',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    prev: 'Previous',
    show: 'Open Velvet',
    mini: 'Mini player',
    quit: 'Quit',
    nothing: 'Nothing playing',
    liked: 'Liked',
    close: 'Close'
  },
  uk: {
    unknownArtist: 'Невідомий виконавець',
    unknownTrack: 'Без назви',
    paused: 'Пауза',
    playing: 'Грає',
    openOn: 'Відкрити в',
    play: 'Грати',
    pause: 'Пауза',
    next: 'Наступний',
    prev: 'Попередній',
    show: 'Відкрити Velvet',
    mini: 'Міні-плеєр',
    quit: 'Вихід',
    nothing: 'Нічого не грає',
    liked: 'Вподобане',
    close: 'Закрити'
  },
  de: {
    unknownArtist: 'Unbekannter Künstler',
    unknownTrack: 'Ohne Titel',
    paused: 'Pausiert',
    playing: 'Wird abgespielt',
    openOn: 'Öffnen auf',
    play: 'Abspielen',
    pause: 'Pause',
    next: 'Weiter',
    prev: 'Zurück',
    show: 'Velvet öffnen',
    mini: 'Miniplayer',
    quit: 'Beenden',
    nothing: 'Nichts wird abgespielt',
    liked: 'Lieblingssongs',
    close: 'Schließen'
  },
  es: {
    unknownArtist: 'Artista desconocido',
    unknownTrack: 'Sin título',
    paused: 'En pausa',
    playing: 'Reproduciendo',
    openOn: 'Abrir en',
    play: 'Reproducir',
    pause: 'Pausa',
    next: 'Siguiente',
    prev: 'Anterior',
    show: 'Abrir Velvet',
    mini: 'Minirreproductor',
    quit: 'Salir',
    nothing: 'No suena nada',
    liked: 'Me gusta',
    close: 'Cerrar'
  },
  fr: {
    unknownArtist: 'Artiste inconnu',
    unknownTrack: 'Sans titre',
    paused: 'En pause',
    playing: 'En lecture',
    openOn: 'Ouvrir sur',
    play: 'Lire',
    pause: 'Pause',
    next: 'Suivant',
    prev: 'Précédent',
    show: 'Ouvrir Velvet',
    mini: 'Mini-lecteur',
    quit: 'Quitter',
    nothing: 'Aucune lecture',
    liked: 'Coups de cœur',
    close: 'Fermer'
  }
}

export function mainStrings(lang: Language | undefined): MainStrings {
  return (lang && STRINGS[lang]) || STRINGS.en
}
