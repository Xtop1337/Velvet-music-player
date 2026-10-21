import { useEffect, useRef } from 'react'
import type { VisualizerMode } from '@shared/types'
import { engine } from '@renderer/audio/engine'

interface Particle {
  a: number
  r: number
  v: number
  size: number
  life: number
}

/** Energy 0..1 of the analyser bins between two frequencies. */
function band(data: Uint8Array, nyq: number, f0: number, f1: number): number {
  const a = Math.max(0, Math.floor((f0 / nyq) * data.length))
  const b = Math.max(a + 1, Math.floor((f1 / nyq) * data.length))
  let s = 0
  for (let k = a; k < b; k++) s += data[k] ?? 0
  return s / (b - a) / 255
}

/**
 * Canvas visualizer driven by the engine's analyser (after the limiter, so it shows what you hear).
 * Drawing pauses while the window is hidden.
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
    let freq = new Uint8Array(1024)
    let wave = new Float32Array(2048)
    let smooth = new Float32Array(48)
    let spin = 0
    let bassAvg = 0
    const particles: Particle[] = []

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const an = engine.analyser
      const nyq = (engine.context?.sampleRate ?? 48000) / 2
      if (an) {
        if (freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount)
        if (wave.length !== an.fftSize) wave = new Float32Array(an.fftSize)
        an.getByteFrequencyData(freq)
        an.getFloatTimeDomainData(wave)
      } else {
        freq.fill(0)
        wave.fill(0)
      }
      const style = getComputedStyle(canvas)
      const accent = style.getPropertyValue('--accent').trim() || '#7c9cff'
      const bass = band(freq, nyq, 30, 160)
      bassAvg += (bass - bassAvg) * 0.08
      const kick = Math.max(0, bass - bassAvg) * 3

      if (mode === 'particles') {
        // fade the previous frame instead of clearing, for soft trails
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = 'rgba(0,0,0,0.18)'
        ctx.fillRect(0, 0, w, h)
        ctx.globalCompositeOperation = 'source-over'
      } else {
        ctx.clearRect(0, 0, w, h)
      }
      ctx.fillStyle = accent
      ctx.strokeStyle = accent

      if (mode === 'bars') {
        const want = Math.max(16, Math.min(96, Math.floor(w / 10)))
        if (smooth.length !== want) smooth = new Float32Array(want)
        const bars = smooth.length
        const gap = 3
        const bw = (w - gap * (bars - 1)) / bars
        for (let i = 0; i < bars; i++) {
          const f0 = 30 * Math.pow(16000 / 30, i / bars)
          const f1 = 30 * Math.pow(16000 / 30, (i + 1) / bars)
          const v = band(freq, nyq, f0, f1)
          smooth[i] += (v - smooth[i]) * 0.35
          const bh = Math.max(3, smooth[i] ** 1.4 * h)
          ctx.globalAlpha = 0.35 + smooth[i] * 0.65
          ctx.beginPath()
          ctx.roundRect(i * (bw + gap), h - bh, bw, bh, Math.min(4, bw / 2))
          ctx.fill()
        }
      } else if (mode === 'wave') {
        const mid = h / 2
        const step = Math.max(1, Math.floor(wave.length / w))
        ctx.lineWidth = 2.5
        ctx.lineJoin = 'round'
        ctx.shadowColor = accent
        ctx.shadowBlur = 14
        for (const [alpha, scale] of [
          [0.25, 1.6],
          [1, 1]
        ] as const) {
          ctx.globalAlpha = alpha
          ctx.beginPath()
          for (let x = 0; x <= w; x++) {
            const v = wave[Math.min(wave.length - 1, x * step)] ?? 0
            const y = mid + v * mid * 0.9 * scale
            if (x === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
        }
        ctx.shadowBlur = 0
      } else if (mode === 'circle') {
        const cx = w / 2
        const cy = h / 2
        const r = Math.min(w, h) * 0.26 * (1 + kick * 0.08)
        const n = 120
        spin += 0.002 + bass * 0.01
        for (let i = 0; i < n; i++) {
          const f0 = 30 * Math.pow(12000 / 30, (i % (n / 2)) / (n / 2))
          const v = band(freq, nyq, f0, f0 * 1.12)
          const len = 4 + v ** 1.3 * Math.min(w, h) * 0.22
          const ang = (i / n) * Math.PI * 2 + spin
          ctx.globalAlpha = 0.35 + v * 0.65
          ctx.lineWidth = Math.max(2, ((Math.PI * 2 * r) / n) * 0.55)
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(ang) * (r + 6), cy + Math.sin(ang) * (r + 6))
          ctx.lineTo(cx + Math.cos(ang) * (r + 6 + len), cy + Math.sin(ang) * (r + 6 + len))
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        const img = coverRef.current
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.clip()
        if (img) {
          ctx.translate(cx, cy)
          ctx.rotate(spin * 0.5)
          ctx.drawImage(img, -r, -r, r * 2, r * 2)
        } else {
          ctx.globalAlpha = 0.25
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
        }
        ctx.restore()
      } else if (mode === 'particles') {
        const cx = w / 2
        const cy = h / 2
        const max = Math.min(w, h) * 0.6
        const spawn = 1 + Math.floor(bass * 6 + kick * 10)
        for (let k = 0; k < spawn && particles.length < 420; k++) {
          particles.push({ a: Math.random() * Math.PI * 2, r: 6 + Math.random() * 20, v: 0.6 + Math.random() * 1.6, size: 1 + Math.random() * 2.4, life: 1 })
        }
        const energy = band(freq, nyq, 200, 4000)
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i]
          p.r += p.v * (1 + bass * 4 + kick * 6)
          p.a += 0.002 + energy * 0.01
          p.life = 1 - p.r / max
          if (p.life <= 0) {
            particles.splice(i, 1)
            continue
          }
          ctx.globalAlpha = Math.min(1, p.life * 1.4)
          ctx.beginPath()
          ctx.arc(cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r, p.size * (1 + kick), 0, Math.PI * 2)
          ctx.fill()
        }
        // glowing core that breathes with the bass
        const core = 10 + bass * 40 + kick * 30
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2)
        g.addColorStop(0, accent)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.5
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, core * 2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  return <canvas ref={ref} className={`visualizer visualizer--${mode} ${className}`} aria-hidden />
}
