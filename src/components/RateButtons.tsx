import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { trackKey } from '@renderer/lib/recommend'
import { useTaste, type Rated } from '@renderer/store/taste'
import { useUi } from '@renderer/store/ui'

/** The user's rating of a song: 1 = 👍, -1 = 👎, 0 = none. Re-renders when ratings change. */
export function useRating(artist: string, title: string): 1 | -1 | 0 {
  const likes = useTaste((s) => s.likes)
  const dislikes = useTaste((s) => s.dislikes)
  return useMemo(() => {
    const key = trackKey(artist, title)
    if (likes.some((d) => d.key === key && d.weight >= 1)) return 1
    if (dislikes.some((d) => d.key === key && d.weight >= 1)) return -1
    return 0
  }, [likes, dislikes, artist, title])
}

/**
 * 👍 "Like" and 👎 "Not interested" for a song. A rating only teaches the recommendations
 * (nothing is downloaded); pressing the same button again takes it back.
 */
export function RateButtons(props: { song: Rated; size?: number; className?: string; onDisliked?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { song, size = 16 } = props
  const rating = useRating(song.artist, song.title)
  const toast = useUi((s) => s.toast)
  const key = trackKey(song.artist, song.title)
  const like = (): void => {
    const taste = useTaste.getState()
    if (rating === 1) return taste.undo(key)
    taste.like(song, 1)
    toast(t('taste.liked'), 'success')
  }
  const dislike = (): void => {
    const taste = useTaste.getState()
    if (rating === -1) return taste.undo(key)
    taste.dislike(song, 1)
    toast(t('taste.noted'), 'info')
    props.onDisliked?.()
  }
  return (
    <span className={`rate ${props.className ?? ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className={`icon-btn icon-btn--sm rate__up ${rating === 1 ? 'is-on' : ''}`} aria-pressed={rating === 1} title={t('taste.like')} aria-label={t('taste.like')} onClick={like}>
        <ThumbsUp size={size} fill={rating === 1 ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--sm rate__down ${rating === -1 ? 'is-on' : ''}`}
        aria-pressed={rating === -1}
        title={t('taste.notInterested')}
        aria-label={t('taste.notInterested')}
        onClick={dislike}
      >
        <ThumbsDown size={size} fill={rating === -1 ? 'currentColor' : 'none'} />
      </button>
    </span>
  )
}
