import { CheckCircle2, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExportProgress } from '@shared/types'
import { formatRate, uid } from '@renderer/lib/format'
import { presetLabel, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { allPresets, usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'
import { Button, Cover, Field, Modal, Segmented, Toggle } from './ui'

export function ExportDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const id = useUi((s) => s.exportId)
  const close = (): void => useUi.getState().openExport(null)
  const track = useLibrary((s) => (id ? s.tracks[id] : undefined))
  const rate = usePlayer((s) => s.rate)
  const preservesPitch = usePlayer((s) => s.preservesPitch)
  const fx = usePlayer((s) => s.fx)
  const presetId = usePlayer((s) => s.activePresetId)
  const ex = useSettings((s) => s.settings.exporter)
  const downloads = useSettings((s) => s.settings.importer.downloadDir)
  const setSection = useSettings((s) => s.setSection)
  const [progress, setProgress] = useState<ExportProgress | null>(null)

  const defaultLabel = useMemo(() => {
    const p = allPresets().find((x) => x.id === presetId)
    if (p && p.id !== 'normal') return presetLabel(p, t)
    return `${formatRate(rate)}${fx.reverb > 0 ? ' + Reverb' : ''}`
  }, [presetId, rate, fx.reverb, t])
  const [label, setLabel] = useState(defaultLabel)

  useEffect(() => {
    setProgress(null)
    setLabel(defaultLabel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => window.velvet.exporter.onProgress((p) => setProgress((cur) => (cur && cur.id === p.id ? p : cur))), [])

  if (!track) return null
  const running = progress?.state === 'running'
  const dir = ex.dir || `${downloads}/Exports`
  const parts = [
    `${t('speed.speed')}: ${formatRate(rate)}`,
    `${t('speed.autoPitch')}: ${preservesPitch ? t('common.on') : t('common.off')}`,
    fx.reverb > 0 && `${t('speed.reverb')}: ${Math.round(fx.reverb * 100)}%`,
    fx.bass && `${t('speed.bass')}: ${fx.bass > 0 ? '+' : ''}${fx.bass} dB`,
    fx.mid && `${t('speed.mid')}: ${fx.mid > 0 ? '+' : ''}${fx.mid} dB`,
    fx.treble && `${t('speed.treble')}: ${fx.treble > 0 ? '+' : ''}${fx.treble} dB`
  ].filter(Boolean) as string[]

  const start = async (): Promise<void> => {
    const job = uid()
    setProgress({ id: job, state: 'running', percent: 0 })
    const res = await window.velvet.exporter.start({
      id: job,
      path: track.path,
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverPath: track.coverPath,
      label: label.trim() || defaultLabel,
      rate,
      preservesPitch,
      reverb: fx.reverb,
      bass: fx.bass,
      mid: fx.mid,
      treble: fx.treble,
      format: ex.format,
      outDir: dir
    })
    setProgress(res)
    if (res.state === 'done' && res.track && ex.addToLibrary) useLibrary.getState().addTracks([res.track])
    if (res.state === 'done') useUi.getState().toast(t('exportFx.done'), 'success')
  }

  return (
    <Modal
      title={t('exportFx.title')}
      onClose={() => !running && close()}
      width={560}
      footer={
        progress?.state === 'done' ? (
          <>
            <Button icon={<FolderOpen size={16} />} onClick={() => progress.file && void window.velvet.library.reveal(progress.file)}>
              {t('menu.showInFolder')}
            </Button>
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={running}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void start()} disabled={running}>
              {t('exportFx.start')}
            </Button>
          </>
        )
      }
    >
      <div className="export-dialog">
        <div className="export-dialog__track">
          <Cover path={track.coverPath} seed={track.id} size={64} rounded={12} />
          <div>
            <strong>
              {trackTitle(track, t)} <span className="muted">({label || defaultLabel})</span>
            </strong>
            <span className="muted">{track.artist}</span>
          </div>
        </div>
        <p className="export-dialog__fx">{parts.join(' · ')}</p>
        <p className="muted small">{t('exportFx.hint')}</p>
        <Field label={t('exportFx.label')}>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} disabled={running} />
        </Field>
        <div className="export-dialog__row">
          <span className="field__label">{t('exportFx.format')}</span>
          <Segmented<'mp3' | 'wav' | 'flac'>
            label={t('exportFx.format')}
            value={ex.format}
            onChange={(v) => setSection('exporter', { format: v })}
            options={[
              { value: 'mp3', label: 'MP3 320' },
              { value: 'flac', label: 'FLAC' },
              { value: 'wav', label: 'WAV' }
            ]}
          />
        </div>
        <div className="export-dialog__row">
          <span className="field__label">{t('exportFx.folder')}</span>
          <span className="export-dialog__dir" title={dir}>
            {dir}
          </span>
          <Button
            icon={<FolderOpen size={15} />}
            onClick={async () => {
              const d = await window.velvet.dialog.pickDir()
              if (d) setSection('exporter', { dir: d })
            }}
          >
            {t('settings.importer.change')}
          </Button>
        </div>
        <div className="export-dialog__row">
          <span className="field__label">{t('exportFx.addToLibrary')}</span>
          <Toggle checked={ex.addToLibrary} onChange={(v) => setSection('exporter', { addToLibrary: v })} label={t('exportFx.addToLibrary')} />
        </div>
        {progress && (
          <div className={`export-dialog__progress is-${progress.state}`}>
            {progress.state === 'done' ? (
              <span>
                <CheckCircle2 size={16} /> {t('exportFx.saved')}
              </span>
            ) : progress.state === 'error' ? (
              <span className="text-danger">{progress.error}</span>
            ) : (
              <span>{t('exportFx.rendering', { percent: Math.round(progress.percent * 100) })}</span>
            )}
            <div className="job__bar">
              <i style={{ width: `${Math.round((progress.state === 'done' ? 1 : progress.percent) * 100)}%` }} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
