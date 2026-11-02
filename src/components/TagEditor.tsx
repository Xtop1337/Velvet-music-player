import { ClipboardPaste, ImagePlus, Link2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { presetLabel } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { allPresets } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { Button, Cover, Field, Modal, Toggle } from './ui'

export function TagEditor(): React.JSX.Element | null {
  const { t } = useTranslation()
  const id = useUi((s) => s.tagEditorId)
  const close = (): void => useUi.getState().editTags(null)
  const track = useLibrary((s) => (id ? s.tracks[id] : undefined))
  const toast = useUi((s) => s.toast)

  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [album, setAlbum] = useState('')
  const [coverPath, setCoverPath] = useState<string | undefined>()
  const [coverUrl, setCoverUrl] = useState('')
  const [presetId, setPresetId] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [writeFile, setWriteFile] = useState(true)
  const [urlMode, setUrlMode] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!track) return
    setTitle(track.title)
    setArtist(track.artist)
    setAlbum(track.album)
    setCoverPath(track.coverPath)
    setCoverUrl(track.coverUrlAuto ? '' : (track.coverUrl ?? ''))
    setPresetId(track.presetId ?? '')
    setLyrics(track.lyrics ?? '')
    setUrlMode(false)
    setUrl('')
    // only reset when another track is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id])

  if (!track) return null

  const loadUrl = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    setBusy(true)
    try {
      setCoverPath(await window.velvet.covers.fromUrl(u))
      if (/^https:\/\//.test(u)) setCoverUrl(u)
      setUrlMode(false)
    } catch {
      toast(t('tags.loadFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const patch = {
      title: title.trim(),
      artist: artist.trim(),
      album: album.trim(),
      coverPath,
      presetId: presetId || undefined,
      lyrics: lyrics.trim() || undefined,
      ...(coverUrl.trim()
        ? { coverUrl: coverUrl.trim(), coverUrlAuto: false }
        : track.coverUrlAuto
          ? {}
          : { coverUrl: undefined, coverUrlAuto: undefined })
    }
    // A new title/artist invalidates an automatically found Discord cover.
    if (!coverUrl.trim() && track.coverUrlAuto && (patch.title !== track.title || patch.artist !== track.artist)) {
      Object.assign(patch, { coverUrl: undefined, coverUrlAuto: undefined })
    }
    useLibrary.getState().updateTrack(track.id, patch)
    if (writeFile) {
      const res = await window.velvet.tags.write({
        path: track.path,
        title: patch.title,
        artist: patch.artist,
        album: patch.album,
        coverPath,
        clearCover: !coverPath,
        lyrics: lyrics.trim() ? lyrics.trim() : undefined
      })
      if (!res.ok) toast(t('tags.writeFailed', { error: res.error }), 'error')
      else toast(t('tags.saved'), 'success')
    } else toast(t('tags.saved'), 'success')
    setBusy(false)
    close()
  }

  return (
    <Modal
      title={t('tags.title')}
      onClose={close}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="tag-editor">
        <div className="tag-editor__cover">
          <Cover path={coverPath} seed={track.id} size={208} rounded={16} />
          <div className="tag-editor__cover-actions">
            <Button
              icon={<ImagePlus size={16} />}
              onClick={async () => {
                const p = await window.velvet.covers.pick()
                if (p) setCoverPath(p)
              }}
            >
              {t('tags.chooseFile')}
            </Button>
            <Button icon={<Link2 size={16} />} onClick={() => setUrlMode(!urlMode)}>
              {t('tags.fromUrl')}
            </Button>
            <Button
              icon={<ClipboardPaste size={16} />}
              onClick={async () => {
                const p = await window.velvet.covers.fromClipboard()
                if (p) setCoverPath(p)
                else toast(t('tags.clipboardEmpty'), 'info')
              }}
            >
              {t('tags.paste')}
            </Button>
            {coverPath && (
              <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => setCoverPath(undefined)}>
                {t('tags.remove')}
              </Button>
            )}
          </div>
          {urlMode && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault()
                void loadUrl()
              }}
            >
              <input className="input" autoFocus placeholder={t('tags.urlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
              <Button type="submit" variant="primary" disabled={busy}>
                {t('tags.load')}
              </Button>
            </form>
          )}
        </div>
        <div className="tag-editor__fields">
          <Field label={t('tags.titleField')}>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label={t('tags.artist')}>
            <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} />
          </Field>
          <Field label={t('tags.album')}>
            <input className="input" value={album} onChange={(e) => setAlbum(e.target.value)} />
          </Field>
          <Field label={t('tags.preset')}>
            <select className="input" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">{t('menu.presetNone')}</option>
              {allPresets().map((p) => (
                <option key={p.id} value={p.id}>
                  {presetLabel(p, t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('tags.coverUrl')} hint={t('tags.coverUrlHint')}>
            <input className="input" value={coverUrl} placeholder="https://…" onChange={(e) => setCoverUrl(e.target.value)} />
          </Field>
          <Field label={t('lyrics.field')} hint={t('lyrics.fieldHint')}>
            <textarea className="input input--area" rows={5} value={lyrics} onChange={(e) => setLyrics(e.target.value)} placeholder="[00:12.00] …" spellCheck={false} />
          </Field>
          <div className="setting-row setting-row--compact">
            <div>
              <strong>{t('tags.writeToFile')}</strong>
              <span>{t('tags.writeHint')}</span>
            </div>
            <Toggle checked={writeFile} onChange={setWriteFile} label={t('tags.writeToFile')} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
