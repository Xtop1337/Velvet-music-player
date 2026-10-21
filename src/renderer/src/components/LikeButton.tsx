import { Heart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLibrary } from '@renderer/store/library'

export function LikeButton({ trackId, size = 18, className = '' }: { trackId: string; size?: number; className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const liked = useLibrary((s) => !!s.tracks[trackId]?.liked)
  const label = liked ? t('liked.remove') : t('liked.add')
  return (
    <button
      type="button"
      className={`like-btn ${liked ? 'is-liked' : ''} ${className}`}
      aria-pressed={liked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        useLibrary.getState().toggleLike(trackId)
      }}
    >
      <Heart size={size} fill={liked ? 'currentColor' : 'none'} />
    </button>
  )
}
