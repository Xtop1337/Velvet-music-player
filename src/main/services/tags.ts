import { ByteVector, File, Picture, PictureType } from 'node-taglib-sharp'
import { coverAsJpeg } from './covers'

export interface TagWrite {
  path: string
  title: string
  artist: string
  album: string
  coverPath?: string
  lyrics?: string
  /** true: remove embedded pictures when coverPath is empty */
  clearCover?: boolean
}

/** Writes title / artist / album / front cover into the audio file itself. */
export function writeTags(t: TagWrite): void {
  const file = File.createFromPath(t.path)
  try {
    const tag = file.tag
    tag.title = t.title
    tag.performers = t.artist ? t.artist.split(/\s*[,;]\s*/).filter(Boolean) : []
    tag.album = t.album
    if (t.lyrics !== undefined) tag.lyrics = t.lyrics
    if (t.coverPath) {
      const data = ByteVector.fromByteArray(coverAsJpeg(t.coverPath))
      const pic = Picture.fromFullData(data, PictureType.FrontCover, 'image/jpeg', 'Cover')
      tag.pictures = [pic]
    } else if (t.clearCover) {
      tag.pictures = []
    }
    file.save()
  } finally {
    file.dispose()
  }
}
