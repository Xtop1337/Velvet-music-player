import { useEffect, useRef } from 'react'
import type { VisualizerMode } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { BeatDetector, Peaks, bandAverage, logBands, rms, smoothBands, triggerIndex } from '@renderer/audio/spectrum'
import { hexToRgb, luminance, toAccent, type RGB } from '@renderer/lib/color'

function contrast(a: string, b: string): number {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  if (!ra || !rb) return 21
  const la = luminance(ra)
  const lb = luminance(rb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Accent colour, or the text colour when the accent would be invisible on the background (e.g. white accent in Snow). */
export function visibleColor(el: Element): string {
  const s = getComputedStyle(el)
  const accent = s.getPropertyValue('--accent').trim() || '#7c9cff'
  const bg = s.getPropertyValue('--bg').trim()
  const text = s.getPropertyValue('--text').trim() || '#ffffff'
  return contrast(accent, bg) < 1.6 ? text : accent
}

function parseColor(c: string): RGB | null {
  const v = c.trim()
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : hexToRgb(v)
}

interface Look {
  /** 64 colours from the low end (index 0) to the treble */
  table: string[]
  dark: boolean
}

/**
 * Colours of the current cover (the `--aurora-*` palette), made vivid and readable on this
 * background, spread over the frequency range: the visualizer takes on the track's colours.
 */
function readLook(el: HTMLElement): Look {
  const s = getComputedStyle(el)
  const onStage = !!el.closest('.viz-stage')
  const bg = parseColor(s.getPropertyValue('--bg')) ?? [10, 10, 20]
  const dark = onStage || luminance(bg) < 0.3
  const accent = parseColor(visibleColor(el)) ?? [124, 156, 255]
  const palette = [1, 2, 3].map((i) => parseColor(s.getPropertyValue(`--aurora-${i}`))).filter((c): c is RGB => !!c)
  const stops = palette.length ? palette.map((c) => toAccent(c, dark)) : [accent]
  if (stops.length === 1) stops.push(stops[0])
  const table: string[] = []
  for (let i = 0; i < 64; i++) {
    const t = (i / 63) * (stops.length - 1)
    const k = Math.min(stops.length - 2, Math.floor(t))
    const f = t - k
    const [a, b] = [stops[k], stops[k + 1]]
    table.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`)
  }
  return { table, dark }
}

interface Particle {
  a: number
  r: number
  v: number
  size: number
  color: string
  spin: number
}

interface Ring {
  r: number
  a: number
}

const BAND_COUNT: Record<VisualizerMode, (w: number) => number> = {
  bars: (w) => Math.max(24, Math.min(128, Math.floor(w / 7))),
  wave: () => 64,
  circle: () => 90,
  particles: () => 48
}

/**
 * Canvas visualizer. It reads its own fine analyser (8192-point FFT) tapped before the volume,
 * so it shows the music itself whatever the volume. Drawing stops while the window is hidden and
 * slows to a calm 20 frames per second while nothing plays.
 */
export function Visualizer({ mode, coverUrl, className = '' }: { mode: VisualizerMode; coverUrl?: string; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const coverRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (!coverUrl) {
      coverRef.current = null
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = coverUrl
    img.onload = () => (coverRef.current = img)
  }, [coverUrl])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let db = new Float32Array(4096)
    let wave = new Float32Array(8192)
    let raw: Float32Array = new Float32Array(0)
    let bands = new Float32Array(0)
    let peaks = new Peaks(0)
    const beat = new BeatDetector()
    const rings: Ring[] = []
    const particles: Particle[] = []
    let pulse = 0
    let spin = 0
    let last = performance.now()
    let lastDraw = 0
    let look = readLook(canvas)
    let lookAt = 0

    const color = (t: number): string => look.table[Math.max(0, Math.min(63, Math.round(t * 63)))]
    const glowMode = (): GlobalCompositeOperation => (look.dark ? 'lighter' : 'source-over')
    /** Fades the previous frame instead of clearing it: soft trails. */
    const fade = (w: number, h: number, amount: number): void => {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = 1
      ctx.fillStyle = `rgba(0, 0, 0, ${amount})`
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
    }
    const drawRings = (cx: number, cy: number, dt: number, speed: number): void => {
      ctx.lineWidth = 2
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i]
        ring.r += speed * dt
        ring.a -= dt * 0.85
        if (ring.a <= 0) {
          rings.splice(i, 1)
          continue
        }
        ctx.globalAlpha = ring.a
        ctx.strokeStyle = color(0.15)
        ctx.beginPath()
        ctx.arc(cx, cy, ring.r, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      const an = engine.vizAnalyser ?? engine.analyser
      const audible = !!an && engine.audible
      // while nothing plays a calm motion at 20 fps is plenty
      if (!audible && now - lastDraw < 50) return
      const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000))
      last = now
      lastDraw = now

      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (now - lookAt > 500) {
        look = readLook(canvas)
        lookAt = now
      }

      if (an && audible) {
        if (db.length !== an.frequencyBinCount) db = new Float32Array(an.frequencyBinCount)
        if (wave.length !== an.fftSize) wave = new Float32Array(an.fftSize)
        an.getFloatFrequencyData(db)
        an.getFloatTimeDomainData(wave)
      } else {
        db.fill(-Infinity)
        wave.fill(0)
      }
      const count = BAND_COUNT[mode](w)
      if (bands.length !== count) {
        bands = new Float32Array(count)
        peaks = new Peaks(count)
      }
      raw = logBands(db, engine.context?.sampleRate ?? 48000, count, raw)

      // Nothing to show (paused, silence, not started): a gentle breathing motion, never an empty canvas.
      let energy = 0
      for (let i = 0; i < count; i++) energy += raw[i]
      if (energy / count < 0.02) {
        const t = now / 1000
        for (let i = 0; i < count; i++) raw[i] = Math.max(raw[i], (0.14 + 0.08 * Math.sin(t * 1.5 + i * 0.32)) * (1 - (i / count) * 0.55))
        const win = Math.min(wave.length, 2048)
        for (let i = 0; i < win; i++) wave[i] = 0.05 * Math.sin(t * 2 + (i / win) * Math.PI * 6)
      }
      smoothBands(bands, raw, dt)
      peaks.update(bands, dt)
      const bass = bandAverage(bands, 0, 0.14)
      const hit = audible ? beat.update(bass, now / 1000) : 0
      pulse = Math.max(pulse * Math.exp(-dt * 7), hit)

      if (mode === 'bars') {
        ctx.clearRect(0, 0, w, h)
        const n = count
        const gap = 2
        const bw = Math.max(1, (w - gap * (n - 1)) / n)
        const refl = h >= 140 ? h * 0.16 : 0
        const base = h - refl
        const maxH = base - 8
        const radius = Math.min(3, bw / 2)
        for (let i = 0; i < n; i++) {
          const v = bands[i]
          const bh = Math.max(2, v ** 1.2 * maxH * (1 + pulse * 0.07))
          const x = i * (bw + gap)
          ctx.fillStyle = color(i / (n - 1))
          ctx.globalAlpha = Math.min(1, 0.5 + v * 0.5 + pulse * 0.15)
          ctx.beginPath()
          ctx.roundRect(x, base - bh, bw, bh, [radius, radius, 1, 1])
          ctx.fill()
          if (refl) {
            ctx.globalAlpha = 0.22 * (0.35 + v)
            ctx.fillRect(x, base + 3, bw, Math.min(refl - 3, bh * 0.45))
          }
          // falling peak cap
          const py = base - Math.max(2, peaks.values[i] ** 1.2 * maxH * (1 + pulse * 0.07)) - 5
          ctx.globalAlpha = 0.92
          ctx.fillRect(x, py, bw, 2)
        }
        if (refl) {
          // the reflection fades out downwards
          const g = ctx.createLinearGradient(0, base, 0, h)
          g.addColorStop(0, 'rgba(0, 0, 0, 0.1)')
          g.addColorStop(1, 'rgba(0, 0, 0, 1)')
          ctx.globalCompositeOperation = 'destination-out'
          ctx.globalAlpha = 1
          ctx.fillStyle = g
          ctx.fillRect(0, base, w, refl)
          ctx.globalCompositeOperation = 'source-over'
        }
      } else if (mode === 'wave') {
        fade(w, h, 0.5)
        const win = Math.min(wave.length, 2048)
        const start = triggerIndex(wave, win)
        const loud = Math.min(1, rms(wave, start, win) * 3)
        const mid = h / 2
        const amp = h * 0.44
        const gain = 1.6
        const grad = ctx.createLinearGradient(0, 0, w, 0)
        for (let k = 0; k <= 4; k++) grad.addColorStop(k / 4, color(k / 4))
        // the spectrum's envelope, mirrored, faint behind everything
        ctx.globalAlpha = 0.06
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.moveTo(0, mid)
        for (let i = 0; i < count; i++) ctx.lineTo((i / (count - 1)) * w, mid - bands[i] * amp)
        for (let i = count - 1; i >= 0; i--) ctx.lineTo((i / (count - 1)) * w, mid + bands[i] * amp)
        ctx.closePath()
        ctx.fill()
        // Every column of pixels shows the lowest and highest sample it covers (all the detail, like
        // an audio editor), and a smooth line through their average shows the shape of the sound.
        const step = 2
        const cols = Math.ceil(w / step) + 1
        const band = new Path2D()
        const line = new Path2D()
        const lows: number[] = []
        for (let c = 0; c < cols; c++) {
          const a = start + Math.floor(((c * step) / w) * win)
          const b = Math.max(a + 1, start + Math.floor((((c + 1) * step) / w) * win))
          let lo = 1
          let hi = -1
          let sum = 0
          for (let k = a; k < b && k < start + win; k++) {
            const v = wave[k] ?? 0
            if (v < lo) lo = v
            if (v > hi) hi = v
            sum += v
          }
          if (hi < lo) lo = hi = 0
          const x = c * step
          const yHi = mid - Math.max(-1, Math.min(1, hi * gain)) * amp
          lows.push(mid - Math.max(-1, Math.min(1, lo * gain)) * amp)
          if (c === 0) band.moveTo(x, yHi)
          else band.lineTo(x, yHi)
          const y = mid - Math.max(-1, Math.min(1, (sum / (b - a)) * gain)) * amp
          if (c === 0) line.moveTo(x, y)
          else line.lineTo(x, y)
        }
        for (let c = cols - 1; c >= 0; c--) band.lineTo(c * step, lows[c])
        band.closePath()
        ctx.fillStyle = grad
        ctx.globalAlpha = 0.22 + loud * 0.18
        ctx.fill(band)
        ctx.strokeStyle = grad
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.globalCompositeOperation = glowMode()
        ctx.globalAlpha = 0.18 + loud * 0.1
        ctx.lineWidth = 6 + loud * 8
        ctx.stroke(line)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.8 + loud * 2
        ctx.stroke(line)
      } else if (mode === 'circle') {
        ctx.clearRect(0, 0, w, h)
        const cx = w / 2
        const cy = h / 2
        const size = Math.min(w, h)
        const R = size * 0.22 * (1 + pulse * 0.05)
        const len = size * 0.2
        // soft glow of the low end behind everything
        const glow = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 2.1)
        glow.addColorStop(0, color(0.05))
        glow.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.18 + bass * 0.3
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, w, h)
        if (hit) rings.push({ r: R + 6, a: 0.25 + hit * 0.45 })
        drawRings(cx, cy, dt, size * 0.32)
        // 180 radial bars, mirrored left / right, bass at the top
        const n = count
        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1.5, ((Math.PI * 2 * R) / (n * 2)) * 0.55)
        for (let i = 0; i < n; i++) {
          const v = bands[i]
          const l = 3 + v ** 1.2 * len * (1 + pulse * 0.12)
          const pl = 3 + peaks.values[i] ** 1.2 * len + 6
          ctx.strokeStyle = color(i / (n - 1))
          ctx.fillStyle = ctx.strokeStyle
          for (const side of [1, -1]) {
            const ang = -Math.PI / 2 + side * ((i + 0.5) / n) * Math.PI
            const c = Math.cos(ang)
            const s = Math.sin(ang)
            ctx.globalAlpha = 0.45 + v * 0.55
            ctx.beginPath()
            ctx.moveTo(cx + c * (R + 6), cy + s * (R + 6))
            ctx.lineTo(cx + c * (R + 6 + l), cy + s * (R + 6 + l))
            ctx.stroke()
            ctx.globalAlpha = 0.8
            ctx.beginPath()
            ctx.arc(cx + c * (R + pl), cy + s * (R + pl), ctx.lineWidth * 0.45, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        // the waveform as a ring around the cover
        const win = Math.min(wave.length, 1024)
        const start = triggerIndex(wave, win)
        ctx.globalAlpha = 0.6
        ctx.strokeStyle = color(0.5)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (let k = 0; k <= 180; k++) {
          const a = (k / 180) * Math.PI * 2 - Math.PI / 2
          const v = wave[start + Math.floor(((k % 180) / 180) * win)] ?? 0
          const r = R - 5 + Math.max(-1, Math.min(1, v * 1.5)) * R * 0.12
          if (k === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
          else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
        }
        ctx.stroke()
        // the cover, slowly turning, a little bigger on each beat
        spin += dt * (0.05 + bass * 0.45)
        const cr = R - 12
        const img = coverRef.current
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, cr, 0, Math.PI * 2)
        ctx.clip()
        ctx.globalAlpha = 1
        if (img) {
          ctx.translate(cx, cy)
          ctx.rotate(spin)
          ctx.drawImage(img, -cr, -cr, cr * 2, cr * 2)
        } else {
          ctx.globalAlpha = 0.3
          ctx.fillStyle = color(0.3)
          ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2)
        }
        ctx.restore()
      } else if (mode === 'particles') {
        fade(w, h, 0.2)
        const cx = w / 2
        const cy = h / 2
        const size = Math.min(w, h)
        const maxR = Math.hypot(w, h) / 2
        const r0 = size * 0.11 * (1 + pulse * 0.1)
        // each part of the spectrum sends its own particles: the bass big and slow, the treble small and quick
        const groups: [number, number][] = [
          [0, 0.1],
          [0.1, 0.22],
          [0.22, 0.38],
          [0.38, 0.56],
          [0.56, 0.76],
          [0.76, 1]
        ]
        groups.forEach(([a, b], g) => {
          const e = bandAverage(bands, a, b)
          const expected = e * e * (g < 2 ? 26 : 42) * dt * 4
          let spawn = Math.floor(expected + Math.random())
          if (g < 2 && hit) spawn += Math.round(hit * 10)
          for (let k = 0; k < spawn && particles.length < 700; k++) {
            particles.push({
              a: Math.random() * Math.PI * 2,
              r: r0 * (0.9 + Math.random() * 0.3),
              v: (45 + g * 40) * (0.6 + Math.random() * 0.8),
              size: Math.max(0.8, (3.4 - g * 0.45) * (0.6 + Math.random() * 0.7)),
              color: color((a + b) / 2),
              spin: (Math.random() - 0.5) * 0.4
            })
          }
        })
        ctx.globalCompositeOperation = glowMode()
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i]
          p.r += p.v * dt * (1 + pulse * 2.4 + bass)
          p.a += p.spin * dt
          const life = 1 - p.r / maxR
          if (life <= 0) {
            particles.splice(i, 1)
            continue
          }
          ctx.globalAlpha = Math.min(1, life * 1.3)
          ctx.fillStyle = p.color
          ctx.beginPath()
          ctx.arc(cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r, p.size * (1 + pulse * 0.6), 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'
        if (hit) rings.push({ r: r0 * 1.4, a: 0.2 + hit * 0.4 })
        drawRings(cx, cy, dt, size * 0.4)
        // the core: the spectrum drawn as a living blob, mirrored
        const pts = count * 2
        const at = (k: number): [number, number] => {
          const i = k < count ? k : pts - 1 - k
          const r = r0 * (1 + bands[i] ** 1.1 * 0.95)
          const a = -Math.PI / 2 + (k / pts) * Math.PI * 2
          return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
        }
        ctx.beginPath()
        const first = at(0)
        const second = at(1)
        ctx.moveTo((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
        for (let k = 1; k <= pts; k++) {
          const p = at(k % pts)
          const q = at((k + 1) % pts)
          ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        }
        ctx.closePath()
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r0 * 2)
        core.addColorStop(0, color(0.1))
        core.addColorStop(1, color(0.7))
        ctx.globalAlpha = 0.55 + pulse * 0.3
        ctx.fillStyle = core
        ctx.fill()
        ctx.globalAlpha = 0.9
        ctx.lineWidth = 1.5
        ctx.strokeStyle = color(0.85)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  return <canvas ref={ref} className={`visualizer visualizer--${mode} ${className}`} aria-hidden />
}
