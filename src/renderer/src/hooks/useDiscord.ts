import { useEffect } from 'react'
import { create } from 'zustand'
import type { DiscordStatus, NowPlayingPayload } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'

const useDiscordStore = create<{ status: DiscordStatus; user?: string }>(() => ({ status: 'disabled' }))

export function useDiscordStatus(): [DiscordStatus, string | undefined] {
  const status = useDiscordStore((s) => s.status)
  const user = useDiscordStore((s) => s.user)
  return [status, user]
}

function payload(): NowPlayingPayload | null {
  const p = usePlayer.getState()
  const track = p.currentId ? useLibrary.getState().tracks[p.currentId] : undefined
  if (!track) return null
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    sourceUrl: track.sourceUrl,
    duration: p.duration || track.duration,
    position: engine.currentTime,
    rate: p.rate,
    playing: p.playing,
    language: useSettings.getState().settings.language
  }
}

/** Keeps Discord Rich Presence in sync with the player. Mount once. */
export function useDiscordSync(): void {
  const discord = useSettings((s) => s.settings.discord)
  const loaded = useSettings((s) => s.loaded)

  useEffect(() => {
    const offStatus = window.velvet.discord.onStatus((status, user) => useDiscordStore.setState({ status, user }))
    void window.velvet.discord.status().then((status) => useDiscordStore.setState({ status }))
    const offCover = window.velvet.discord.onCover((trackId, url) => {
      const t = useLibrary.getState().tracks[trackId]
      if (t && !t.coverUrl) useLibrary.getState().updateTrack(trackId, { coverUrl: url, coverUrlAuto: true })
    })
    return () => {
      offStatus()
      offCover()
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    void window.velvet.discord.configure(discord).then(() => window.velvet.discord.update(payload()))
  }, [discord, loaded])

  useEffect(() => {
    let timer: number | null = null
    const push = (): void => {
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => void window.velvet.discord.update(payload()), 250)
    }
    const offPlayer = usePlayer.subscribe((s, prev) => {
      if (s.currentId !== prev.currentId || s.playing !== prev.playing || s.rate !== prev.rate || Math.abs(s.duration - prev.duration) > 1) push()
    })
    const offLib = useLibrary.subscribe((s, prev) => {
      const id = usePlayer.getState().currentId
      if (id && s.tracks[id] !== prev.tracks[id]) push()
    })
    const offSeek = engine.on('seeked', push)
    const offLang = useSettings.subscribe((s, prev) => {
      if (s.settings.language !== prev.settings.language) push()
    })
    return () => {
      offPlayer()
      offLib()
      offSeek()
      offLang()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
