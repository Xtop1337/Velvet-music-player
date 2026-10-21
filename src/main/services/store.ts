import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths'

const NAMES = new Set(['library', 'settings', 'history'])

function fileFor(name: string): string {
  if (!NAMES.has(name)) throw new Error(`Unknown store: ${name}`)
  return join(paths.data, `${name}.json`)
}

export function loadStore<T>(name: string): T | null {
  const file = fileFor(name)
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as T
    } catch {
      // corrupted file: fall through to the backup
    }
  }
  return null
}

/** Atomic write: tmp file + rename, keeping the previous version as .bak */
export function saveStore(name: string, data: unknown): void {
  const file = fileFor(name)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  if (existsSync(file)) {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // ignore, the rename below still replaces the file
    }
  }
  renameSync(tmp, file)
}
