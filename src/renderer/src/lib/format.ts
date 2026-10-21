export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}x`
}

export function uid(): string {
  return crypto.randomUUID()
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function shuffleArray<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Stable pleasant gradient for tracks without a cover. */
export function placeholderGradient(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  const a = Math.abs(h) % 360
  const b = (a + 40 + (Math.abs(h >> 8) % 80)) % 360
  return `linear-gradient(135deg, hsl(${a} 70% 62%), hsl(${b} 72% 48%))`
}
