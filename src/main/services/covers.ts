import { clipboard, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { paths } from './paths'

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp'
}

/** Stores image bytes in the covers cache under a content hash and returns the file path. */
export function saveCoverBuffer(data: Uint8Array, mime = 'image/jpeg'): string {
  const ext = MIME_EXT[mime.toLowerCase()] ?? 'jpg'
  const hash = createHash('sha1').update(data).digest('hex')
  const file = join(paths.covers, `${hash}.${ext}`)
  if (!existsSync(file)) writeFileSync(file, data)
  return file
}

export function coverFromFile(file: string): string {
  const ext = extname(file).slice(1).toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  return saveCoverBuffer(readFileSync(file), mime)
}

export async function coverFromUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
  if (!mime.startsWith('image/')) throw new Error('URL is not an image')
  return saveCoverBuffer(new Uint8Array(await res.arrayBuffer()), mime)
}

export function coverFromClipboard(): string | null {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  return saveCoverBuffer(img.toPNG(), 'image/png')
}

/** Downscales a cover to a JPEG thumbnail, used when embedding into files. */
export function coverAsJpeg(file: string, size = 1000): Buffer {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return readFileSync(file)
  const { width } = img.getSize()
  return (width > size ? img.resize({ width: size, quality: 'best' }) : img).toJPEG(92)
}

export function mimeForPath(file: string): string {
  const ext = extname(file).slice(1).toLowerCase()
  return Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'image/jpeg'
}
