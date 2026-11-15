import { Cloud, Youtube } from 'lucide-react'
import type { SearchSource } from '@shared/types'

export function SpotifyLogo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#1DB954" />
      <path d="M6.3 9.2c3.9-1.1 8.2-.8 11.6 1.1M7 12.6c3.2-.9 6.6-.6 9.4 1M7.7 15.8c2.5-.7 5.1-.5 7.3.8" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export const SOURCE_NAMES: Record<SearchSource, string> = { soundcloud: 'SoundCloud', youtube: 'YouTube', spotify: 'Spotify' }

/** The service's mark in its own colour. */
export function SourceIcon({ source, size = 16 }: { source: SearchSource; size?: number }): React.JSX.Element {
  if (source === 'spotify') return <SpotifyLogo size={size} />
  if (source === 'youtube') return <Youtube size={size} color="#ff0033" />
  return <Cloud size={size} color="#ff5500" />
}
