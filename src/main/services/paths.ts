import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  get data(): string {
    return ensure(app.getPath('userData'))
  },
  get covers(): string {
    return ensure(join(app.getPath('userData'), 'covers'))
  },
  get bin(): string {
    return ensure(join(app.getPath('userData'), 'bin'))
  },
  get cache(): string {
    return ensure(join(app.getPath('userData'), 'cache'))
  },
  get defaultDownloads(): string {
    return ensure(join(app.getPath('music'), 'Velvet'))
  }
}
