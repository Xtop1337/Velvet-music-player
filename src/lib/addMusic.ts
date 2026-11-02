import type { TFunction } from 'i18next'
import type { Track } from '@shared/types'
import { useLibrary } from '@renderer/store/library'
import { useUi } from '@renderer/store/ui'

function report(tracks: Track[], t: TFunction): void {
  const added = useLibrary.getState().addTracks(tracks)
  useUi.getState().toast(added ? t('library.added', { count: added }) : t('library.nothingNew'), added ? 'success' : 'info')
}

export async function addPicked(kind: 'files' | 'folder', t: TFunction): Promise<void> {
  const tracks = await window.velvet.library.pick(kind)
  if (tracks.length) report(tracks, t)
}

export async function addDropped(paths: string[], t: TFunction): Promise<void> {
  if (!paths.length) return
  report(await window.velvet.library.scan(paths), t)
}
