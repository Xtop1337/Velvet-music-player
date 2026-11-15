import type { HistoryEntry, SmartField, SmartOp, SmartPlaylist, SmartRule, Track } from '@shared/types'
import { decadeOf } from './genres'
import { lastPlayed, playCounts } from './forgotten'
import { uid } from './format'

const DAY = 86_400_000

export type FieldKind = 'number' | 'text' | 'bool' | 'days'

export const FIELDS: { field: SmartField; kind: FieldKind }[] = [
  { field: 'plays', kind: 'number' },
  { field: 'playsRecent', kind: 'number' },
  { field: 'liked', kind: 'bool' },
  { field: 'addedDays', kind: 'days' },
  { field: 'notPlayedDays', kind: 'days' },
  { field: 'genre', kind: 'text' },
  { field: 'artist', kind: 'text' },
  { field: 'album', kind: 'text' },
  { field: 'title', kind: 'text' },
  { field: 'year', kind: 'number' },
  { field: 'bpm', kind: 'number' },
  { field: 'key', kind: 'text' },
  { field: 'mode', kind: 'text' },
  { field: 'duration', kind: 'number' },
  { field: 'source', kind: 'text' },
  { field: 'hasNote', kind: 'bool' }
]

export function kindOf(field: SmartField): FieldKind {
  return FIELDS.find((f) => f.field === field)?.kind ?? 'text'
}

export function opsFor(kind: FieldKind): SmartOp[] {
  if (kind === 'number') return ['gte', 'lte', 'eq', 'neq']
  if (kind === 'days') return ['lte', 'gte']
  if (kind === 'bool') return ['is', 'isNot']
  return ['contains', 'notContains', 'eq', 'neq']
}

export function defaultRule(field: SmartField = 'plays'): SmartRule {
  const kind = kindOf(field)
  return { field, op: opsFor(kind)[0], value: kind === 'bool' ? 'true' : kind === 'days' ? '7' : kind === 'number' ? '5' : '' }
}

/** Everything a rule may ask about a track, computed once per evaluation. */
interface Ctx {
  now: number
  plays: Map<string, number>
  recent: Map<string, number>
  last: Map<string, number>
}

function value(t: Track, field: SmartField, c: Ctx): string | number | boolean | null {
  switch (field) {
    case 'plays':
      return c.plays.get(t.id) ?? 0
    case 'playsRecent':
      return c.recent.get(t.id) ?? 0
    case 'liked':
      return !!t.liked
    case 'addedDays':
      return (c.now - t.addedAt) / DAY
    case 'notPlayedDays':
      return (c.now - (c.last.get(t.id) ?? t.addedAt)) / DAY
    case 'genre':
      return t.genre ?? ''
    case 'artist':
      return t.artist
    case 'album':
      return t.album
    case 'title':
      return t.title
    case 'year':
      return t.year ?? null
    case 'bpm':
      return t.bpm ?? null
    case 'key':
      return `${t.key ?? ''} ${t.camelot ?? ''}`.trim()
    case 'mode':
      return /minor/i.test(t.key ?? '') ? 'minor' : t.key ? 'major' : ''
    case 'duration':
      return t.duration / 60
    case 'source':
      return t.source
    case 'hasNote':
      return !!t.note?.trim()
  }
}

export function matchesRule(t: Track, r: SmartRule, c: Ctx): boolean {
  const v = value(t, r.field, c)
  const kind = kindOf(r.field)
  if (kind === 'bool') {
    const want = r.value !== 'false'
    return r.op === 'isNot' ? v !== want : v === want
  }
  if (kind === 'number' || kind === 'days') {
    const raw = String(r.value).trim()
    const n = Number(raw.replace(',', '.'))
    if (!raw || !Number.isFinite(n)) return true // empty or half-typed value: no filter yet
    if (v === null) return false
    const x = v as number
    // "within N days" (lte) / "more than N days ago" (gte); numbers: ≥ ≤ = ≠
    if (r.op === 'gte') return x >= n
    if (r.op === 'lte') return x <= n
    if (r.op === 'eq') return Math.round(x) === Math.round(n)
    return Math.round(x) !== Math.round(n)
  }
  const s = String(v ?? '').toLowerCase()
  const q = String(r.value).trim().toLowerCase()
  if (!q) return true
  if (r.op === 'contains') return s.includes(q)
  if (r.op === 'notContains') return !s.includes(q)
  if (r.op === 'eq') return s === q
  return s !== q
}

/** The tracks of a smart playlist, sorted and limited as it says. */
export function evaluateSmart(pl: SmartPlaylist, tracks: Record<string, Track>, history: HistoryEntry[], order: string[], now = Date.now()): string[] {
  const recent = new Map<string, number>()
  for (const h of history) if (h.s >= 30 && now - h.at <= 30 * DAY) recent.set(h.t, (recent.get(h.t) ?? 0) + 1)
  const c: Ctx = { now, plays: playCounts(tracks, history), recent, last: lastPlayed(tracks, history) }
  const rules = pl.rules
  const ok = (t: Track): boolean =>
    !rules.length || (pl.match === 'any' ? rules.some((r) => matchesRule(t, r, c)) : rules.every((r) => matchesRule(t, r, c)))
  let ids = order.filter((id) => tracks[id] && !tracks[id].stream && ok(tracks[id]))
  const key = pl.sort.key
  if (key === 'random') {
    // stable within a day
    const day = Math.floor(now / DAY)
    const h = (id: string): number => {
      let x = day
      for (const ch of id) x = (Math.imul(x, 31) + ch.charCodeAt(0)) | 0
      return x
    }
    ids = [...ids].sort((a, b) => h(a) - h(b))
  } else if (key !== 'added') {
    const val = (id: string): string | number => {
      const t = tracks[id]
      if (key === 'plays') return c.plays.get(id) ?? 0
      if (key === 'lastPlayed') return c.last.get(id) ?? 0
      if (key === 'bpm') return t.bpm ?? 0
      return (key === 'title' ? t.title : t.artist).toLowerCase()
    }
    ids = [...ids].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const d = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string)
      return pl.sort.desc ? -d : d
    })
  } else if (!pl.sort.desc) ids = [...ids].reverse()
  return pl.limit > 0 ? ids.slice(0, pl.limit) : ids
}

export type TemplateId = 'oftenNotLiked' | 'addedWeek' | 'forgottenLoved' | 'fast' | 'calm' | 'decade'

/** Ready-made rules. */
export function smartTemplate(id: TemplateId, name: string, now = Date.now()): SmartPlaylist {
  const base = { id: uid(), name, createdAt: now, limit: 0, match: 'all' as const }
  switch (id) {
    case 'oftenNotLiked':
      return { ...base, rules: [{ field: 'plays', op: 'gte', value: '5' }, { field: 'liked', op: 'is', value: 'false' }], sort: { key: 'plays', desc: true } }
    case 'addedWeek':
      return { ...base, rules: [{ field: 'addedDays', op: 'lte', value: '7' }], sort: { key: 'added', desc: true } }
    case 'forgottenLoved':
      return { ...base, rules: [{ field: 'liked', op: 'is', value: 'true' }, { field: 'notPlayedDays', op: 'gte', value: '60' }], sort: { key: 'lastPlayed', desc: false } }
    case 'fast':
      return { ...base, rules: [{ field: 'bpm', op: 'gte', value: '125' }], sort: { key: 'bpm', desc: true } }
    case 'calm':
      return { ...base, rules: [{ field: 'bpm', op: 'lte', value: '95' }], sort: { key: 'random', desc: false } }
    case 'decade': {
      const d = decadeOf(new Date(now).getFullYear() - 20) ?? 2000
      return { ...base, rules: [{ field: 'year', op: 'gte', value: String(d) }, { field: 'year', op: 'lte', value: String(d + 9) }], sort: { key: 'random', desc: false } }
    }
  }
}
