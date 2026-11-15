/**
 * Raw genre tags ("Deep House", "Russian Rap", "Альтернатива"…) grouped into a few families
 * for mixes, statistics and the offline radio.
 */
export type GenreFamily =
  | 'phonk'
  | 'funk'
  | 'hiphop'
  | 'electronic'
  | 'dance'
  | 'lofi'
  | 'pop'
  | 'rock'
  | 'metal'
  | 'indie'
  | 'rnb'
  | 'jazz'
  | 'classical'
  | 'ambient'
  | 'soundtrack'
  | 'folk'
  | 'latin'
  | 'kpop'
  | 'other'

// first match wins, so the more specific families come first
const RULES: [GenreFamily, RegExp][] = [
  ['phonk', /phonk|фонк|drift|cowbell/i],
  // Brazilian funk and its internet offspring ("funk", "mtg", "montagem", "automotivo"…)
  ['funk', /funk|фанк|\bmtg\b|montagem|automotivo|baile|mandel[aã]o|bruxaria/i],
  ['lofi', /lo-?fi|chillhop|лоу.?фай/i],
  ['kpop', /k-?pop|j-?pop|anime/i],
  ['hiphop', /hip.?hop|\brap\b|rap\/|trap|drill|grime|рэп|реп\b|хип.?хоп|трэп/i],
  ['metal', /metal|core\b|metalcore|deathcore|метал/i],
  ['rnb', /r&b|rnb|r'n'b|soul|рнб|соул/i],
  ['dance', /dance|house|disco|eurodance|edm|club|hardstyle|танц|хаус/i],
  ['electronic', /electro|techno|trance|dubstep|drum.?(and|&|n).?bass|dnb|synth|idm|garage|breakbeat|bass|wave|электр|техно/i],
  ['ambient', /ambient|chill|downtempo|new age|meditat|эмбиент/i],
  ['indie', /indie|alternative|alt\b|shoegaze|dream pop|инди|альтерн/i],
  ['rock', /rock|punk|grunge|рок|панк/i],
  ['jazz', /jazz|blues|swing|bossa|джаз|блюз/i],
  ['classical', /classical|orchestra|baroque|opera|piano|symphon|классик|оркестр/i],
  ['soundtrack', /soundtrack|score|\bost\b|film|game|саундтрек/i],
  ['folk', /folk|country|acoustic|singer.?songwriter|bard|шансон|бард|фолк|кантри/i],
  ['latin', /latin|reggaeton|salsa|bachata|cumbia|латин/i],
  ['pop', /pop|эстрада|поп/i]
]

export function genreFamily(genre: string | undefined): GenreFamily | null {
  if (!genre || !genre.trim()) return null
  for (const [family, re] of RULES) if (re.test(genre)) return family
  return 'other'
}

/**
 * Words in a title / artist / album that name the genre outright. Catalogues file phonk and
 * Brazilian funk under "Rap" or "Electro", so these words say more than the genre tag does.
 */
const KEYWORDS: [GenreFamily, RegExp][] = [
  ['phonk', /phonk|фонк|\bdrift\b|cowbell/i],
  ['funk', /\bfunk\b|фанк|\bmtg\b|montagem|automotivo|\bbaile\b|mandel[aã]o|bruxaria/i],
  ['lofi', /\blo-?fi\b/i],
  ['hiphop', /\b(drill|trap|rap|freestyle)\b|рэп/i],
  ['dance', /\bhardstyle\b|\bhouse\b/i],
  ['electronic', /\b(dnb|dubstep|techno|synthwave|hyperpop)\b|drum (and|&|n) bass/i],
  ['kpop', /\b(k-?pop|j-?pop)\b|anime/i]
]

/** The family named by words in the text itself, if any. */
export function keywordFamily(text: string): GenreFamily | null {
  for (const [family, re] of KEYWORDS) if (re.test(text)) return family
  return null
}

/**
 * A track's genre family: words in its title / artist / album first (see `KEYWORDS`), then its
 * genre tag. `null` when nothing is known.
 */
export function trackFamily(t: { title?: string; artist?: string; album?: string; genre?: string }): GenreFamily | null {
  const tagged = genreFamily(t.genre)
  // a precise tag (e.g. SoundCloud's "Phonk") wins; a coarse one gives way to the words
  if (tagged === 'phonk' || tagged === 'funk') return tagged
  const worded = keywordFamily(`${t.title ?? ''} ${t.artist ?? ''} ${t.album ?? ''}`)
  if (worded) return worded
  return tagged === 'other' ? null : tagged
}

/** How close two families sound, 0..1 (1 = the same). Pairs not listed are unrelated. */
const NEAR: [GenreFamily, GenreFamily, number][] = [
  ['phonk', 'funk', 0.8],
  ['phonk', 'hiphop', 0.35],
  ['phonk', 'electronic', 0.4],
  ['phonk', 'dance', 0.3],
  ['funk', 'hiphop', 0.3],
  ['funk', 'electronic', 0.35],
  ['funk', 'dance', 0.4],
  ['funk', 'latin', 0.35],
  ['hiphop', 'rnb', 0.5],
  ['hiphop', 'lofi', 0.3],
  ['electronic', 'dance', 0.7],
  ['electronic', 'ambient', 0.4],
  ['electronic', 'lofi', 0.3],
  ['electronic', 'pop', 0.25],
  ['dance', 'pop', 0.45],
  ['pop', 'rnb', 0.45],
  ['pop', 'indie', 0.4],
  ['pop', 'kpop', 0.5],
  ['pop', 'latin', 0.35],
  ['rock', 'metal', 0.55],
  ['rock', 'indie', 0.6],
  ['rock', 'folk', 0.25],
  ['indie', 'folk', 0.35],
  ['jazz', 'rnb', 0.35],
  ['jazz', 'classical', 0.25],
  ['jazz', 'lofi', 0.3],
  ['ambient', 'lofi', 0.5],
  ['ambient', 'classical', 0.35],
  ['classical', 'soundtrack', 0.5],
  ['ambient', 'soundtrack', 0.35]
]
const AFFINITY = new Map<string, number>()
for (const [a, b, v] of NEAR) {
  AFFINITY.set(`${a}|${b}`, v)
  AFFINITY.set(`${b}|${a}`, v)
}

export function familyAffinity(a: GenreFamily | null, b: GenreFamily | null): number {
  if (!a || !b) return 0
  if (a === b) return a === 'other' ? 0.3 : 1
  return AFFINITY.get(`${a}|${b}`) ?? 0
}

/**
 * How well a family fits a taste (families with their shares, summing to 1): the best of
 * "share × closeness", scaled so the user's main family scores 1.
 */
export function tasteFit(family: GenreFamily | null, taste: Map<GenreFamily, number>): number {
  if (!family || !taste.size) return 0
  const top = Math.max(...taste.values())
  if (top <= 0) return 0
  let best = 0
  for (const [f, share] of taste) best = Math.max(best, (share / top) * familyAffinity(family, f))
  return best
}

export const GENRE_FAMILIES: GenreFamily[] = RULES.map(([f]) => f).concat('other')

/** 1987 → 1980 */
export function decadeOf(year: number | undefined): number | null {
  if (!year || year < 1900 || year > 2100) return null
  return Math.floor(year / 10) * 10
}
