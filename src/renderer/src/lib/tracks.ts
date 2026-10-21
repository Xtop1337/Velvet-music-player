import type { TFunction } from 'i18next'
import type { Track } from '@shared/types'

export function trackTitle(t: Track | undefined, tr: TFunction): string {
  return t?.title || tr('track.unknownTitle')
}

export function trackArtist(t: Track | undefined, tr: TFunction): string {
  return t?.artist || tr('track.unknownArtist')
}

export function matchesQuery(t: Track, q: string): boolean {
  if (!q) return true
  const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

export function totalDuration(tracks: Track[]): number {
  return tracks.reduce((s, t) => s + (t.duration || 0), 0)
}

export function presetLabel(p: { id: string; name: string; builtIn?: boolean }, tr: TFunction): string {
  return p.builtIn ? tr(`presets.${p.id}`, { defaultValue: p.name }) : p.name
}

export const TRACK_DRAG_TYPE = 'application/x-velvet-tracks'
