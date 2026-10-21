export type RGB = [number, number, number]

const cache = new Map<string, RGB[]>()

/** Extracts up to 3 vivid dominant colours from an image URL. */
export async function extractPalette(url: string): Promise<RGB[]> {
  if (!url) return []
  const hit = cache.get(url)
  if (hit) return hit
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  try {
    await img.decode()
  } catch {
    return []
  }
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  ctx.drawImage(img, 0, 0, size, size)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    return []
  }
  // Bucket colours (4 bits per channel) weighted by saturation.
  const buckets = new Map<number, { r: number; g: number; b: number; w: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    const lum = (max + min) / 510
    if (lum < 0.08 || lum > 0.95) continue
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const w = 0.25 + sat * sat * 2
    const e = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 }
    e.r += r * w
    e.g += g * w
    e.b += b * w
    e.w += w
    buckets.set(key, e)
  }
  const sorted = [...buckets.values()].sort((a, b) => b.w - a.w)
  const out: RGB[] = []
  for (const e of sorted) {
    const c: RGB = [Math.round(e.r / e.w), Math.round(e.g / e.w), Math.round(e.b / e.w)]
    if (out.every((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) > 90)) out.push(c)
    if (out.length === 3) break
  }
  cache.set(url, out)
  return out
}

export function luminance([r, g, b]: RGB): number {
  const f = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Boosts saturation/lightness of a cover colour so it works as an accent. */
export function toAccent([r, g, b]: RGB, dark: boolean): RGB {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  let h = 0
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    const rr = r / 255
    const gg = g / 255
    const bb = b / 255
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
  }
  const S = Math.max(s, 0.55)
  const L = dark ? Math.min(Math.max(l, 0.62), 0.74) : Math.min(Math.max(l, 0.42), 0.55)
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = L - c / 2
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)]
}
