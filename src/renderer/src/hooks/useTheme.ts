import { useEffect, useState } from 'react'
import { extractPalette, hexToRgb, luminance, rgbToHex, toAccent, type RGB } from '@renderer/lib/color'
import { mediaUrl } from '@renderer/lib/media'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'

const WINDOW_COLORS = {
  snow: { bg: '#f2f4f8', fg: '#1b2333' },
  midnight: { bg: '#071026', fg: '#ffffff' },
  aurora: { bg: '#0a0a16', fg: '#ffffff' }
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

/** Applies theme, accent, radius, font size and background settings to the document. */
export function useTheme(): void {
  const s = useSettings((st) => st.settings)
  const systemDark = useSystemDark()
  const currentId = usePlayer((st) => st.currentId)
  const coverPath = useLibrary((st) => (currentId ? st.tracks[currentId]?.coverPath : undefined))
  const [palette, setPalette] = useState<RGB[]>([])

  const theme = s.theme === 'system' ? (systemDark ? 'midnight' : 'snow') : s.theme
  const dark = theme !== 'snow'

  useEffect(() => {
    let alive = true
    if (!coverPath) {
      setPalette([])
      return
    }
    void extractPalette(mediaUrl(coverPath)).then((p) => alive && setPalette(p))
    return () => {
      alive = false
    }
  }, [coverPath])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.density = s.density
    root.dataset.animations = s.animations ? 'on' : 'off'
    root.lang = s.language
    root.style.setProperty('--radius', `${s.radius}px`)
    root.style.setProperty('--font-scale', String(s.fontScale))

    // accent: cover colour > custom colour > theme default
    let accent: string | null = null
    if (s.accentFromCover && palette[0]) accent = rgbToHex(toAccent(palette[0], dark))
    else if (s.accent) accent = s.accent
    if (accent) root.style.setProperty('--accent', accent)
    else root.style.removeProperty('--accent')
    const rgb = hexToRgb(accent ?? getComputedStyle(root).getPropertyValue('--theme-accent').trim()) ?? [79, 107, 255]
    root.style.setProperty('--accent-rgb', rgb.join(', '))
    root.style.setProperty('--on-accent', luminance(rgb) > 0.45 ? '#0b1630' : '#ffffff')

    // aurora colours from the cover
    const fallback: RGB[] = [
      [92, 64, 220],
      [20, 140, 190],
      [200, 60, 150]
    ]
    const pal = [0, 1, 2].map((i) => palette[i] ?? palette[0] ?? fallback[i])
    pal.forEach((c, i) => root.style.setProperty(`--aurora-${i + 1}`, `rgb(${c.join(', ')})`))

    const bgOn =
      (s.backgroundMode === 'image' && !!s.backgroundImage) || (s.backgroundMode === 'video' && !!s.backgroundVideo) || s.backgroundMode === 'cover'
    root.style.setProperty('--bg-user-image', s.backgroundMode === 'image' && s.backgroundImage ? `url("${mediaUrl(s.backgroundImage)}")` : 'none')
    root.style.setProperty('--bg-user-blur', `${s.backgroundBlur}px`)
    root.style.setProperty('--bg-user-dim', String(s.backgroundDim))
    root.dataset.bgImage = bgOn ? 'on' : 'off'
    root.dataset.bgMode = s.backgroundMode

    void window.velvet.app.setWindowTheme(WINDOW_COLORS[theme])
  }, [theme, dark, s.accent, s.accentFromCover, s.radius, s.fontScale, s.density, s.animations, s.backgroundImage, s.backgroundVideo, s.backgroundMode, s.backgroundBlur, s.backgroundDim, s.language, palette])
}
