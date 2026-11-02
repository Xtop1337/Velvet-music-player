import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@renderer/lib/format'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { Cover, IconButton, PlayingBars } from './ui'

export function QueuePanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useUi((s) => s.queueOpen)
  const setOpen = useUi((s) => s.setQueue)
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const playing = usePlayer((s) => s.playing)
  const tracks = useLibrary((s) => s.tracks)
  if (!open) return null

  const current = index >= 0 ? tracks[queue[index]] : undefined
  const upcoming = queue.map((id, i) => ({ id, i })).slice(index + 1)

  return (
    <aside className="queue-panel">
      <header>
        <h3>{t('queue.title')}</h3>
        <IconButton label={t('common.close')} size="sm" onClick={() => setOpen(false)}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="queue-panel__body">
        {current && (
          <>
            <h4>{t('queue.nowPlaying')}</h4>
            <div className="queue-item is-current">
              <Cover path={current.coverPath} seed={current.id} size={40} rounded={8} />
              <div className="queue-item__text">
                <span>{trackTitle(current, t)}</span>
                <small>{trackArtist(current, t)}</small>
              </div>
              <PlayingBars paused={!playing} />
            </div>
          </>
        )}
        <h4>{t('queue.upNext')}</h4>
        {upcoming.length === 0 && <p className="muted">{t('queue.empty')}</p>}
        {upcoming.map(({ id, i }) => {
          const tr = tracks[id]
          if (!tr) return null
          return (
            <div key={`${id}-${i}`} className="queue-item" onDoubleClick={() => void usePlayer.getState().jumpTo(i)}>
              <button type="button" className="queue-item__hit" onClick={() => void usePlayer.getState().jumpTo(i)}>
                <Cover path={tr.coverPath} seed={tr.id} size={40} rounded={8} />
                <div className="queue-item__text">
                  <span>{trackTitle(tr, t)}</span>
                  <small>
                    {trackArtist(tr, t)} · {formatTime(tr.duration)}
                  </small>
                </div>
              </button>
              <IconButton label={t('queue.remove')} size="sm" className="queue-item__remove" onClick={() => usePlayer.getState().removeFromQueue(i)}>
                <X size={15} />
              </IconButton>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
