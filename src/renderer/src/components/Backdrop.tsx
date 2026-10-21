import { useEffect, useRef } from 'react'
import { engine } from '@renderer/audio/engine'
import { mediaUrl } from '@renderer/lib/media'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'

/** Apple-Music-style moving background built from blurred copies of the current cover. */
function LiveCover(): React.JSX.Element {
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const coverPath = useLibrary((s) => (currentId ? s.tracks[currentId]?.coverPath : undefined))
  const reactive = useSettings((s) => s.settings.liveReactive)
  const intensity = useSettings((s) => s.settings.liveIntensity)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !reactive) {
      el?.style.setProperty('--pulse', '1')
      return
    }
    let raf = 0
    let data = new Uint8Array(1024)
    let level = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const an = engine.analyser
      if (!an || document.hidden) return
      if (data.length !== an.frequencyBinCount) data = new Uint8Array(an.frequencyBinCount)
      an.getByteFrequencyData(data)
      const nyq = (engine.context?.sampleRate ?? 48000) / 2
      const end = Math.max(2, Math.floor((150 / nyq) * data.length))
      let s = 0
      for (let i = 1; i < end; i++) s += data[i]
      const bass = s / (end - 1) / 255
      level += (bass - level) * (bass > level ? 0.3 : 0.06)
      el.style.setProperty('--pulse', String(1 + level * 0.09 * intensity))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reactive, intensity])

  const url = coverPath ? `url("${mediaUrl(coverPath)}")` : undefined
  return (
    <div ref={ref} className={`live-bg ${playing ? 'is-playing' : ''}`} style={{ ['--live' as string]: intensity }}>
      {url ? [0, 1, 2, 3].map((i) => <i key={`${coverPath}-${i}`} style={{ backgroundImage: url }} />) : <span className="live-bg__fallback" />}
    </div>
  )
}

export function Backdrop(): React.JSX.Element | null {
  const mode = useSettings((s) => s.settings.backgroundMode)
  const video = useSettings((s) => s.settings.backgroundVideo)
  if (mode === 'image') return <div className="user-bg" />
  if (mode === 'video' && video) {
    return (
      <div className="user-video">
        <video src={mediaUrl(video)} autoPlay loop muted playsInline />
      </div>
    )
  }
  if (mode === 'cover') return <LiveCover />
  return null
}
