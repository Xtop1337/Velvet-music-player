import { Loader2, Play, Shuffle } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutToggle, useLayout } from '@renderer/components/LayoutToggle'
import { MixCollage, mixGradient, mixTitle, playMix } from '@renderer/components/MixCard'
import { TrackView } from '@renderer/components/TrackGrid'
import { Button } from '@renderer/components/ui'
import { forgottenTracks } from '@renderer/lib/forgotten'
import { withNewSongs } from '@renderer/lib/mixes'
import { useLibrary } from '@renderer/store/library'
import { useMixes } from '@renderer/store/mixes'
import { usePlayer } from '@renderer/store/player'
import { useStats } from '@renderer/store/stats'

/** A daily mix, or the "Forgotten tracks" (`id` = 'forgotten'). */
export function MixPage({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [layout, setLayout] = useLayout('mix')
  const tracks = useLibrary((s) => s.tracks)
  const history = useStats((s) => s.history)
  const mix = useMixes((s) => s.mixes.find((m) => m.id === id))
  const filling = useMixes((s) => !!s.filling[id])
  const forgotten = id === 'forgotten'

  useEffect(() => {
    void useMixes
      .getState()
      .ensure()
      .then(() => {
        if (!forgotten) void useMixes.getState().fillNew(id)
      })
  }, [id, forgotten])

  const ids = useMemo(() => {
    if (forgotten) return forgottenTracks(tracks, history)
    return mix ? withNewSongs(mix).filter((x) => tracks[x]) : []
  }, [forgotten, mix, tracks, history])

  const title = forgotten ? t('forgotten.title') : mix ? mixTitle(mix, t) : ''
  const gradient = mixGradient(forgotten ? 'forgotten' : (mix?.mood ?? mix?.family ?? mix?.artist ?? id))
  const play = (shuffle: boolean): void => {
    const p = usePlayer.getState()
    if (shuffle !== p.shuffle) p.setShuffle(shuffle)
    if (mix && !shuffle) void playMix(mix)
    else void p.playQueue(ids, shuffle ? Math.floor(Math.random() * ids.length) : 0)
  }

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <MixCollage ids={ids} gradient={gradient} size="lg" />
        <div className="playlist-hero__info">
          <span className="eyebrow">{forgotten ? t('forgotten.eyebrow') : t('mixes.eyebrow')}</span>
          <h1>{title}</h1>
          <p className="muted">
            {forgotten ? t('forgotten.text') : t('mixes.text', { artists: mix?.artists.slice(0, 4).map((a) => a.name).join(', ') ?? '' })}
          </p>
          <p className="muted small">
            {t('common.tracks', { count: ids.length })}
            {!forgotten && ` · ${t('mixes.renews')}`}
            {filling && (
              <span className="inline-loading">
                <Loader2 size={13} className="spin" /> {t('mixes.addingNew')}
              </span>
            )}
          </p>
          <div className="playlist-hero__actions no-drag">
            <Button variant="primary" icon={<Play size={16} fill="currentColor" />} disabled={!ids.length} onClick={() => play(false)}>
              {t('library.playAll')}
            </Button>
            <Button icon={<Shuffle size={16} />} disabled={!ids.length} onClick={() => play(true)}>
              {t('library.shuffle')}
            </Button>
            <div className="toolbar__spacer" />
            <LayoutToggle value={layout} onChange={setLayout} />
          </div>
        </div>
      </header>
      {ids.length ? <TrackView ids={ids} layout={layout} /> : <p className="muted pad">{forgotten ? t('forgotten.none') : t('mixes.gone')}</p>}
    </div>
  )
}
