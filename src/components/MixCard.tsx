import { Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Track } from '@shared/types'
import type { DailyMix } from '@renderer/lib/mixes'
import { withNewSongs } from '@renderer/lib/mixes'
import { useLibrary } from '@renderer/store/library'
import { useMixes } from '@renderer/store/mixes'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { Cover } from './ui'

/** "Mix: Rock", "Energetic", "Mix: Øneheart & similar". */
export function mixTitle(mix: DailyMix, t: TFunction): string {
  if (mix.kind === 'genre' && mix.family) return t('mixes.genre', { name: t(`genres.${mix.family}`) })
  if (mix.kind === 'mood' && mix.mood) return t(`mixes.moods.${mix.mood}`)
  return t('mixes.artist', { artist: mix.artist ?? '' })
}

const GRADIENTS: Record<string, string> = {
  energetic: 'linear-gradient(135deg, #ff5f6d, #ffc371)',
  calm: 'linear-gradient(135deg, #43cea2, #185a9d)',
  melancholic: 'linear-gradient(135deg, #5f72bd, #9b23ea)',
  forgotten: 'linear-gradient(135deg, #f7971e, #ffd200)'
}

export function mixGradient(key: string): string {
  if (GRADIENTS[key]) return GRADIENTS[key]
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 50) % 360} 75% 42%))`
}

/** Plays a mix (library songs at once; the day's new songs join as soon as they are found). */
export async function playMix(mix: DailyMix): Promise<void> {
  const tracks = useLibrary.getState().tracks
  const ids = withNewSongs(mix).filter((id) => tracks[id])
  if (!ids.length) return
  await usePlayer.getState().playQueue(ids, 0)
  if (mix.newIds.length) return
  await useMixes.getState().fillNew(mix.id)
  const filled = useMixes.getState().mixes.find((m) => m.id === mix.id)
  const p = usePlayer.getState()
  // still this mix: put the new songs in, keeping what plays
  if (filled?.newIds.length && p.queue.length === ids.length && p.queue.every((id, i) => id === ids[i])) {
    const next = withNewSongs(filled).filter((id) => useLibrary.getState().tracks[id])
    const index = Math.max(0, next.indexOf(p.currentId ?? ''))
    usePlayer.setState({ queue: next, original: next, index })
  }
}

/** Four covers of the mix, a colour wash and its name. */
export function MixCollage({ ids, label, gradient, size }: { ids: string[]; label?: string; gradient: string; size?: 'lg' }): React.JSX.Element {
  const tracks = useLibrary((s) => s.tracks)
  const covers: Track[] = []
  for (const id of ids) {
    const t = tracks[id]
    if (t && (t.coverPath || t.coverUrl) && !covers.some((c) => (c.coverPath ?? c.coverUrl) === (t.coverPath ?? t.coverUrl))) covers.push(t)
    if (covers.length === 4) break
  }
  return (
    <div className={`mix-collage ${size === 'lg' ? 'mix-collage--lg' : ''}`} style={{ background: gradient }}>
      {covers.length === 4 && (
        <div className="mix-collage__grid">
          {covers.map((c) => (
            <Cover key={c.id} path={c.coverPath} url={c.coverUrl} seed={c.id} className="mix-collage__cover" />
          ))}
        </div>
      )}
      {covers.length > 0 && covers.length < 4 && <Cover path={covers[0].coverPath} url={covers[0].coverUrl} seed={covers[0].id} className="mix-collage__single" />}
      <span className="mix-collage__wash" style={{ background: gradient }} />
      {label && <span className="mix-collage__label">{label}</span>}
    </div>
  )
}

export function MixCard({ mix }: { mix: DailyMix }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useUi((s) => s.navigate)
  const title = mixTitle(mix, t)
  return (
    <div className="mix-card" onClick={() => navigate({ type: 'mix', id: mix.id })}>
      <div className="mix-card__art">
        <MixCollage ids={mix.trackIds} label={title} gradient={mixGradient(mix.mood ?? mix.family ?? mix.artist ?? mix.id)} />
        <button
          type="button"
          className="grid-card__play"
          aria-label={t('player.play')}
          onClick={(e) => {
            e.stopPropagation()
            void playMix(mix)
          }}
        >
          <Play size={20} fill="currentColor" />
        </button>
      </div>
      <strong>{title}</strong>
      <small>{mix.artists.slice(0, 3).map((a) => a.name).join(', ')}</small>
    </div>
  )
}
