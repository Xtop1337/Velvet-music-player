import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { engine } from '@renderer/audio/engine'
import { mediaUrl } from '@renderer/lib/media'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'

/** OS media keys / overlay integration. */
export function useMediaSession(): void {
  const { t } = useTranslation()
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))

  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    const p = (): ReturnType<typeof usePlayer.getState> => usePlayer.getState()
    ms.setActionHandler('play', () => void p().play())
    ms.setActionHandler('pause', () => p().pause())
    ms.setActionHandler('previoustrack', () => void p().prev())
    ms.setActionHandler('nexttrack', () => void p().next())
    ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && p().seek(d.seekTime))
    ms.setActionHandler('seekbackward', () => p().seek(engine.currentTime - 10))
    ms.setActionHandler('seekforward', () => p().seek(engine.currentTime + 10))
  }, [])

  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    if (!track) {
      ms.metadata = null
      return
    }
    const meta = new MediaMetadata({ title: trackTitle(track, t), artist: trackArtist(track, t), album: track.album })
    ms.metadata = meta
    // Media Session only accepts http/data/blob artwork, so the cover is handed over as a blob.
    let blobUrl = ''
    let alive = true
    if (track.coverPath) {
      void fetch(mediaUrl(track.coverPath))
        .then((r) => r.blob())
        .then((b) => {
          if (!alive) return
          blobUrl = URL.createObjectURL(b)
          meta.artwork = [{ src: blobUrl, sizes: '512x512', type: b.type }]
        })
        .catch(() => {})
    }
    return () => {
      alive = false
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [track, t])

  useEffect(() => {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = currentId ? (playing ? 'playing' : 'paused') : 'none'
  }, [playing, currentId])
}
