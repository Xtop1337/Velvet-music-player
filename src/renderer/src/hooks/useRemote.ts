import { useEffect } from 'react'
import type { RemoteState } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'

function snapshot(): RemoteState {
  const p = usePlayer.getState()
  const t = p.currentId ? useLibrary.getState().tracks[p.currentId] : undefined
  const s = useSettings.getState().settings
  const root = document.documentElement
  const css = getComputedStyle(root)
  return {
    trackId: t?.id ?? null,
    title: t?.title ?? '',
    artist: t?.artist ?? '',
    album: t?.album ?? '',
    coverPath: t?.coverPath,
    playing: p.playing,
    position: engine.currentTime,
    duration: p.duration,
    rate: p.rate,
    liked: !!t?.liked,
    theme: (root.dataset.theme as RemoteState['theme']) || 'snow',
    accent: css.getPropertyValue('--accent').trim(),
    onAccent: css.getPropertyValue('--on-accent').trim(),
    language: s.language
  }
}

/** Bridges the player to the tray, the mini player and global shortcuts. Main window only. */
export function useRemote(): void {
  const desktop = useSettings((s) => s.settings.desktop)
  const language = useSettings((s) => s.settings.language)
  const loaded = useSettings((s) => s.loaded)

  useEffect(() => {
    if (loaded) void window.velvet.remote.setPrefs({ ...desktop, language })
  }, [desktop, language, loaded])

  useEffect(() => {
    let timer: number | null = null
    const push = (): void => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = null
        window.velvet.remote.pushState(snapshot())
      }, 120)
    }
    const offP = usePlayer.subscribe((s, prev) => {
      if (s.currentId !== prev.currentId || s.playing !== prev.playing || s.rate !== prev.rate || s.duration !== prev.duration) push()
    })
    const offL = useLibrary.subscribe((s, prev) => {
      const id = usePlayer.getState().currentId
      if (id && s.tracks[id] !== prev.tracks[id]) push()
    })
    const offS = useSettings.subscribe((s, prev) => {
      if (s.settings.theme !== prev.settings.theme || s.settings.accent !== prev.settings.accent || s.settings.language !== prev.settings.language) window.setTimeout(push, 50)
    })
    const offSeek = engine.on('seeked', push)
    // keep the mini player's progress fresh
    const tick = window.setInterval(() => usePlayer.getState().playing && push(), 1000)
    const offCmd = window.velvet.remote.onCommand((c) => {
      const p = usePlayer.getState()
      if (c.cmd === 'toggle') void p.toggle()
      else if (c.cmd === 'next') void p.next()
      else if (c.cmd === 'prev') void p.prev()
      else if (c.cmd === 'seek') p.seek(c.value)
      else if (c.cmd === 'volume') p.setVolume(p.volume + c.value)
      else if (c.cmd === 'like' && p.currentId) useLibrary.getState().toggleLike(p.currentId)
    })
    push()
    return () => {
      offP()
      offL()
      offS()
      offSeek()
      offCmd()
      clearInterval(tick)
      if (timer) clearTimeout(timer)
    }
  }, [])
}
