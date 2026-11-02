import { useEffect, useRef } from 'react'
import { engine } from '@renderer/audio/engine'
import { mediaUrl } from '@renderer/lib/media'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'

/**
 * The animated backgrounds (Aurora blobs and the live cover) drawn on one small canvas.
 *
 * They used to be up to seven window-sized CSS layers; every frame of their motion made the
 * browser re-composite all of them, which cost a whole CPU core while music played. The content
 * is heavily blurred anyway, so it is painted here at a quarter of the window resolution,
 * 10–20 times per second, only while music plays — and the browser just scales up one layer.
 */

const SCALE = 0.25
/** The Aurora drift is very slow: 10 updates per second look the same as 60. */
const FPS_AURORA = 10
/** The live cover turns faster and pulses with the bass. */
const FPS_LIVE = 20
/** While another app is in front, nobody looks closely: half the rate. */
const FPS_UNFOCUSED = 8

// ── shared math ────────────────────────────────────────────────────────────────

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) // ≈ ease-in-out
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Progress through an `alternate` animation with three keyframes (0 / 50 / 100 %). */
function alternate(time: number, duration: number, delay: number): { seg: 0 | 1; t: number } {
  const cycle = (((time - delay) / duration) % 2 + 2) % 2 // 0..2, second half runs backwards
  const p = cycle <= 1 ? cycle : 2 - cycle
  return p < 0.5 ? { seg: 0, t: ease(p * 2) } : { seg: 1, t: ease((p - 0.5) * 2) }
}

// ── Aurora (Glass theme) ───────────────────────────────────────────────────────

interface AuroraBlob {
  color: number // index of --aurora-N
  size: number // vmax
  opacity: number
  duration: number
  delay: number
  /** top-left corner in container units (fractions) and vmax margin */
  place: (cw: number, ch: number, vmax: number, size: number) => { x: number; y: number }
}

// Same geometry as the old `.aurora i` CSS: container inset -20%, gradient circles of 92 / 62 vmax.
const BLOBS: AuroraBlob[] = [
  { color: 1, size: 92, opacity: 0.55, duration: 26, delay: 0, place: (cw, ch, v) => ({ x: -0.05 * cw - 16 * v, y: -0.1 * ch - 16 * v }) },
  {
    color: 2,
    size: 92,
    opacity: 0.55,
    duration: 32,
    delay: -8,
    place: (cw, ch, v, s) => ({ x: cw * 1.1 + 16 * v - s, y: ch * 1.15 + 16 * v - s })
  },
  { color: 3, size: 62, opacity: 0.4, duration: 38, delay: -16, place: (cw, ch, v) => ({ x: 0.4 * cw - 11 * v, y: 0.3 * ch - 11 * v }) }
]

// gradient stops of the old CSS radial-gradient (closest-side)
const STOPS: [number, number][] = [
  [0, 1],
  [0.3, 1],
  [0.46, 0.7],
  [0.64, 0.32],
  [0.82, 0.09],
  [1, 0]
]

function drawAurora(ctx: CanvasRenderingContext2D, w: number, h: number, time: number, colors: string[], alpha: number): void {
  const vw = w / 100
  const vh = h / 100
  const vmax = Math.max(w, h) / 100
  const x0 = -0.2 * w
  const y0 = -0.2 * h
  const cw = 1.4 * w
  const ch = 1.4 * h
  for (const b of BLOBS) {
    const size = b.size * vmax
    const { x, y } = b.place(cw, ch, vmax, size)
    // drift keyframes: 0 → (8vw, 6vh, 1.12) → (-6vw, 10vh, 0.95)
    const { seg, t } = alternate(time, b.duration, b.delay)
    const k = seg === 0 ? [0, 0, 1, 8, 6, 1.12] : [8, 6, 1.12, -6, 10, 0.95]
    const tx = lerp(k[0], k[3], t) * vw
    const ty = lerp(k[1], k[4], t) * vh
    const sc = lerp(k[2], k[5], t)
    const cx = x0 + x + size / 2 + tx
    const cy = y0 + y + size / 2 + ty
    const r = (size / 2) * sc
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    const rgb = colors[b.color - 1] || 'rgb(120,120,255)'
    for (const [at, a] of STOPS) g.addColorStop(at, rgb.replace(/^rgb\((.*)\)$/, `rgba($1, ${a})`))
    ctx.globalAlpha = b.opacity * alpha
    ctx.fillStyle = g
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  }
  ctx.globalAlpha = 1
}

// ── Live cover ─────────────────────────────────────────────────────────────────

interface Orbit {
  /** element rect in container fractions */
  left: number
  top: number
  size: number
  duration: number
  reverse: boolean
}

// Same geometry as the original `.live-bg i` CSS: container inset -25%, 70 % boxes with 40 % corners.
const ORBITS: Orbit[] = [
  { left: 0, top: 0, size: 0.7, duration: 40, reverse: false },
  { left: 0.3, top: 0, size: 0.7, duration: 52, reverse: true },
  { left: 0.1, top: 0.3, size: 0.7, duration: 64, reverse: false },
  { left: 0.45, top: 0.45, size: 0.5, duration: 34, reverse: true }
]

export interface LiveLook {
  opacity: number
  /** CSS filter of the whole group, in canvas pixels */
  filter: string
  veil: { color: string; alpha: number }
}

/** The whole live background group (layers + dimming veil), unfiltered, in container coordinates. */
function paintLiveGroup(lc: CanvasRenderingContext2D, cw: number, ch: number, time: number, img: CanvasImageSource | null, fallback: boolean, colors: string[], look: LiveLook): void {
  lc.clearRect(0, 0, cw, ch)
  if (img) {
    const iw0 = (img as HTMLCanvasElement).width
    const ih0 = (img as HTMLCanvasElement).height
    for (const o of ORBITS) {
      const ew = o.size * cw
      const eh = o.size * ch
      let p = (time / o.duration) % 1
      if (o.reverse) p = 1 - p
      // keyframes: rotate(a) translateX(t % of width) rotate(b) scale(s), linear
      const half = p < 0.5 ? p * 2 : (p - 0.5) * 2
      const [a0, t0, b0, s0, a1, t1, b1, s1] = p < 0.5 ? [0, 6, 0, 1, 180, 10, -90, 1.15] : [180, 10, -90, 1.15, 360, 6, -360, 1]
      lc.save()
      lc.translate(o.left * cw + ew / 2, o.top * ch + eh / 2)
      lc.rotate((lerp(a0, a1, half) * Math.PI) / 180)
      lc.translate((lerp(t0, t1, half) / 100) * ew, 0)
      lc.rotate((lerp(b0, b1, half) * Math.PI) / 180)
      const s = lerp(s0, s1, half)
      lc.scale(s, s)
      lc.beginPath()
      lc.roundRect(-ew / 2, -eh / 2, ew, eh, [{ x: ew * 0.4, y: eh * 0.4 }])
      lc.clip()
      // background: center / cover
      const k = Math.max(ew / iw0, eh / ih0)
      lc.globalAlpha = look.opacity
      lc.drawImage(img, (-iw0 * k) / 2, (-ih0 * k) / 2, iw0 * k, ih0 * k)
      lc.restore()
    }
  } else if (fallback) {
    // no cover: two soft spots in the palette colours (`.live-bg__fallback`)
    const r = Math.hypot(0.7 * cw, 0.7 * ch) * 0.6
    lc.globalAlpha = 0.6
    for (const [fx, fy, c0] of [
      [0.3, 0.3, colors[0]],
      [0.7, 0.7, colors[1]]
    ] as [number, number, string][]) {
      const c = c0 || 'rgb(120, 120, 255)'
      const g = lc.createRadialGradient(fx * cw, fy * ch, 0, fx * cw, fy * ch, r)
      g.addColorStop(0, c)
      g.addColorStop(1, c.replace(/^rgb\((.*)\)$/, 'rgba($1, 0)'))
      lc.fillStyle = g
      lc.fillRect(0, 0, cw, ch)
    }
  }
  // the dimming veil (`.live-bg::after`) sits inside the group, under the same filter
  lc.globalAlpha = Math.min(1, look.veil.alpha)
  lc.fillStyle = look.veil.color
  lc.fillRect(0, 0, cw, ch)
  lc.globalAlpha = 1
}

const canvasFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype

/** The group is blurred by ≥ 40 px, so it is painted and blurred at half the canvas resolution (⅛ of the window). */
const GROUP_SCALE = 0.5

function fit(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c.getContext('2d')!
}

function drawLive(
  ctx: CanvasRenderingContext2D,
  layers: { group: HTMLCanvasElement; blurred: HTMLCanvasElement },
  w: number,
  h: number,
  time: number,
  img: CanvasImageSource | null,
  fallback: boolean,
  colors: string[],
  look: LiveLook,
  pulse: number
): void {
  const cw = Math.max(1, Math.round(1.5 * w * GROUP_SCALE))
  const ch = Math.max(1, Math.round(1.5 * h * GROUP_SCALE))
  paintLiveGroup(fit(layers.group, cw, ch), cw, ch, time, img, fallback, colors, look)
  // the group's CSS filter (blur, saturation), applied once at low resolution
  const bc = fit(layers.blurred, cw, ch)
  bc.clearRect(0, 0, cw, ch)
  if (canvasFilter) bc.filter = look.filter
  bc.drawImage(layers.group, 0, 0)
  bc.filter = 'none'
  ctx.save()
  // bass pulse: the group scales around its centre, after the filter
  ctx.translate(w / 2, h / 2)
  ctx.scale(pulse, pulse)
  ctx.translate(-w / 2, -h / 2)
  ctx.drawImage(layers.blurred, -0.25 * w, -0.25 * h, 1.5 * w, 1.5 * h)
  ctx.restore()
}

// ── the cover, decoded once and shrunk (it is blurred by ~40 px anyway) ───────────

const coverCache = new Map<string, Promise<HTMLCanvasElement>>()

function smallCover(url: string): Promise<HTMLCanvasElement> {
  let hit = coverCache.get(url)
  if (!hit) {
    hit = (async () => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      await img.decode()
      const k = Math.min(1, 192 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * k))
      c.height = Math.max(1, Math.round(img.naturalHeight * k))
      const cc = c.getContext('2d')!
      cc.imageSmoothingQuality = 'high'
      cc.drawImage(img, 0, 0, c.width, c.height)
      return c
    })()
    if (coverCache.size > 8) coverCache.delete(coverCache.keys().next().value!)
    coverCache.set(url, hit)
    hit.catch(() => coverCache.delete(url))
  }
  return hit
}

// ── component ──────────────────────────────────────────────────────────────────

export function BackgroundCanvas(): React.JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null)
  const mode = useSettings((s) => s.settings.backgroundMode)
  const theme = useSettings((s) => s.settings.theme)
  const userBlur = useSettings((s) => s.settings.backgroundBlur)
  const intensity = useSettings((s) => s.settings.liveIntensity)
  const reactive = useSettings((s) => s.settings.liveReactive)
  const playing = usePlayer((s) => s.playing)
  // the full-window Now Playing screen is opaque: nothing to animate underneath
  const covered = useUi((s) => s.nowPlayingOpen)
  const currentId = usePlayer((s) => s.currentId)
  const coverPath = useLibrary((s) => (currentId ? s.tracks[currentId]?.coverPath : undefined))
  const state = useRef({ time: 0, img: null as HTMLCanvasElement | null, pulse: 1, level: 0 })

  const live = mode === 'cover'

  // decode the current cover once
  useEffect(() => {
    let alive = true
    if (!live || !coverPath) {
      state.current.img = null
      window.dispatchEvent(new Event('velvet:bg-redraw'))
      return
    }
    void smallCover(mediaUrl(coverPath))
      .then((img) => {
        if (!alive) return
        state.current.img = img
        window.dispatchEvent(new Event('velvet:bg-redraw'))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [live, coverPath])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')!
    let colors: string[] = []
    let look: LiveLook = { opacity: 1, filter: 'none', veil: { color: '#000', alpha: 0 } }
    const layers = { group: document.createElement('canvas'), blurred: document.createElement('canvas') }
    let colorsAt = 0
    let freq = new Uint8Array(1024)
    let timer: number | null = null
    let last = performance.now()
    const root = document.documentElement

    const showsAurora = (): boolean => root.dataset.theme === 'aurora' && !live && root.dataset.bgMode !== 'video'
    const active = (): boolean => live || showsAurora()

    const draw = (): void => {
      const aurora = showsAurora()
      if (!aurora && !live) {
        el.style.display = 'none'
        return
      }
      el.style.display = 'block'
      const w = Math.max(1, Math.round(window.innerWidth * SCALE))
      const h = Math.max(1, Math.round(window.innerHeight * SCALE))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
      }
      const now = performance.now()
      if (now - colorsAt > 500) {
        const cs = getComputedStyle(root)
        colors = [1, 2, 3].map((i) => cs.getPropertyValue(`--aurora-${i}`).trim())
        // the look of the original `.live-bg` CSS (the Snow theme is softer and brighter)
        const dim = Number(cs.getPropertyValue('--bg-user-dim')) || 0
        const snow = root.dataset.theme === 'snow'
        const blur = ((snow ? 50 : 40) + userBlur) * SCALE * GROUP_SCALE
        look = {
          opacity: 0.45 + intensity * 0.5,
          filter: snow
            ? `blur(${blur}px) saturate(${0.8 + intensity * 0.5}) brightness(1.1)`
            : `blur(${blur}px) saturate(${1 + intensity * 0.9})`,
          veil: { color: cs.getPropertyValue('--bg').trim() || '#000', alpha: snow ? Math.max(0.45, dim) : 0.25 + dim * 0.75 }
        }
        colorsAt = now
      }
      ctx.clearRect(0, 0, w, h)
      const st = state.current
      if (aurora) drawAurora(ctx, w, h, st.time, colors, root.dataset.bgImage === 'on' ? 0.45 : 1)
      // while a new cover decodes, the previous one stays; without any cover, the palette spots
      if (live) drawLive(ctx, layers, w, h, st.time, coverPath ? st.img : null, !coverPath, colors, look, st.pulse)
    }

    const tick = (): void => {
      timer = null
      if (!active()) {
        draw()
        return
      }
      const now = performance.now()
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const st = state.current
      // "animations off" in the settings freezes the drift, like it did for the CSS version
      if (root.dataset.animations !== 'off') st.time += dt
      // bass pulse for the live background
      const an = engine.analyser
      if (live && reactive && an && engine.audible) {
        if (freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount)
        an.getByteFrequencyData(freq)
        const nyq = (engine.context?.sampleRate ?? 48000) / 2
        const end = Math.max(2, Math.floor((150 / nyq) * freq.length))
        let s = 0
        for (let i = 1; i < end; i++) s += freq[i]
        const bass = s / (end - 1) / 255
        st.level += (bass - st.level) * (bass > st.level ? 0.65 : 0.17) // the old 60 fps smoothing, per 50 ms
        st.pulse = 1 + st.level * 0.09 * intensity
      } else st.pulse += (1 - st.pulse) * 0.3
      draw()
      if (!document.hidden && !covered) {
        const fps = !document.hasFocus() ? FPS_UNFOCUSED : live ? FPS_LIVE : FPS_AURORA
        timer = window.setTimeout(tick, 1000 / fps)
      }
    }

    /** Draws now and, while music plays in a visible window, keeps the loop running. */
    const kick = (): void => {
      if (playing && !covered && !document.hidden && active()) {
        if (timer === null) {
          last = performance.now()
          tick()
        }
      } else draw()
    }
    const redraw = (): void => draw()
    // the theme, palette or background mode change through attributes on <html>
    const mo = new MutationObserver(() => {
      colorsAt = 0
      kick()
    })
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-bg-mode', 'data-bg-image', 'data-animations', 'style'] })
    window.addEventListener('resize', redraw)
    window.addEventListener('velvet:bg-redraw', redraw)
    document.addEventListener('visibilitychange', kick)

    if (!playing) state.current.pulse = 1
    kick() // a single still frame while paused
    return () => {
      if (timer) clearTimeout(timer)
      mo.disconnect()
      window.removeEventListener('resize', redraw)
      window.removeEventListener('velvet:bg-redraw', redraw)
      document.removeEventListener('visibilitychange', kick)
    }
  }, [playing, covered, live, reactive, intensity, userBlur, theme, coverPath])

  return <canvas ref={canvas} className="bg-canvas" aria-hidden />
}
