import { FileAudio, Link, Minus, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_PRESETS, RATE_MAX, RATE_MIN } from '@shared/defaults'
import type { Preset } from '@shared/types'
import { formatRate, uid } from '@renderer/lib/format'
import { presetLabel } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'
import { Slider, Toggle } from './ui'

const QUICK = [0.5, 0.75, 0.8, 0.9, 1, 1.25, 1.5, 2, 2.5, 3]

function db(v: number): string {
  return `${v > 0 ? '+' : ''}${v} dB`
}

export function SpeedPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const rate = usePlayer((s) => s.rate)
  const preservesPitch = usePlayer((s) => s.preservesPitch)
  const fx = usePlayer((s) => s.fx)
  const activePresetId = usePlayer((s) => s.activePresetId)
  const currentId = usePlayer((s) => s.currentId)
  const trackPreset = useLibrary((s) => (currentId ? s.tracks[currentId]?.presetId : undefined))
  const custom = useSettings((s) => s.settings.customPresets)
  const p = usePlayer.getState()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const presets: Preset[] = [...BUILTIN_PRESETS, ...custom]

  const savePreset = (): void => {
    const n = name.trim()
    if (!n) return
    const preset: Preset = {
      id: uid(),
      name: n,
      rate,
      preservesPitch,
      reverb: fx.reverb,
      bass: fx.bass,
      mid: fx.mid,
      treble: fx.treble
    }
    useSettings.getState().set({ customPresets: [...custom, preset] })
    usePlayer.setState({ activePresetId: preset.id })
    setNaming(false)
    setName('')
    useUi.getState().toast(t('speed.presetSaved', { name: n }), 'success')
  }

  const deletePreset = (id: string): void => {
    useSettings.getState().set({ customPresets: custom.filter((c) => c.id !== id) })
    if (activePresetId === id) usePlayer.setState({ activePresetId: '' })
  }

  const bindToTrack = (on: boolean): void => {
    if (!currentId) return
    useLibrary.getState().updateTrack(currentId, { presetId: on && activePresetId ? activePresetId : undefined })
    if (on) useUi.getState().toast(t('speed.bound'), 'success')
  }

  return (
    <div className="speed-panel" role="dialog" aria-label={t('speed.title')}>
      <div className="speed-panel__head">
        <h3>{t('speed.title')}</h3>
        <button type="button" className="link-btn" onClick={() => p.applyPreset(BUILTIN_PRESETS[0])}>
          <RotateCcw size={14} /> {t('speed.reset')}
        </button>
      </div>

      <div className="speed-panel__col">
      <section className="speed-panel__rate">
        <div className="rate-display">
          <button type="button" className="icon-btn icon-btn--sm" aria-label="-0.05x" onClick={() => p.setRate(rate - 0.05)}>
            <Minus size={16} />
          </button>
          <span className="rate-display__value">{formatRate(rate)}</span>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="+0.05x" onClick={() => p.setRate(rate + 0.05)}>
            <Plus size={16} />
          </button>
        </div>
        <Slider
          className="slider--rate"
          label={t('speed.speed')}
          min={RATE_MIN}
          max={RATE_MAX}
          step={0.01}
          value={rate}
          origin={1}
          wheelStep={0.05}
          onChange={p.setRate}
          formatValue={formatRate}
        />
        <div className="rate-scale" aria-hidden>
          <span>{formatRate(RATE_MIN)}</span>
          <span style={{ left: `${((1 - RATE_MIN) / (RATE_MAX - RATE_MIN)) * 100}%` }}>1x</span>
          <span style={{ left: `${((2 - RATE_MIN) / (RATE_MAX - RATE_MIN)) * 100}%` }}>2x</span>
          <span>{formatRate(RATE_MAX)}</span>
        </div>
        <div className="chips">
          {QUICK.map((q) => (
            <button key={q} type="button" className={`chip ${Math.abs(rate - q) < 0.001 ? 'is-active' : ''}`} onClick={() => p.setRate(q)}>
              {formatRate(q)}
            </button>
          ))}
        </div>
      </section>

      <section className="speed-panel__pitch">
        <div>
          <strong>{t('speed.autoPitch')}</strong>
          <span>{preservesPitch ? t('speed.autoPitchOn') : t('speed.autoPitchOff')}</span>
        </div>
        <Toggle checked={preservesPitch} onChange={p.setPreservesPitch} label={t('speed.autoPitch')} />
      </section>

      <section className="speed-panel__fx">
        <h4>{t('speed.effects')}</h4>
        <label className="fx-row">
          <span>{t('speed.reverb')}</span>
          <Slider label={t('speed.reverb')} min={0} max={1} step={0.01} value={fx.reverb} onChange={(v) => p.setFx({ reverb: v })} formatValue={(v) => `${Math.round(v * 100)}%`} />
          <output>{Math.round(fx.reverb * 100)}%</output>
        </label>
        {(['bass', 'mid', 'treble'] as const).map((k) => (
          <label className="fx-row" key={k}>
            <span>{t(`speed.${k}`)}</span>
            <Slider label={t(`speed.${k}`)} min={-12} max={12} step={1} origin={0} value={fx[k]} onChange={(v) => p.setFx({ [k]: v })} formatValue={db} />
            <output>{db(fx[k])}</output>
          </label>
        ))}
      </section>

      </div>
      <div className="speed-panel__col">
      <section className="speed-panel__presets">
        <h4>{t('speed.presets')}</h4>
        <div className="preset-grid">
          {presets.map((pr) => (
            <div key={pr.id} className={`preset ${activePresetId === pr.id ? 'is-active' : ''}`}>
              <button type="button" className="preset__btn" onClick={() => p.applyPreset(pr)}>
                <span className="preset__name">{presetLabel(pr, t)}</span>
                <span className="preset__meta">
                  {formatRate(pr.rate)}
                  {pr.reverb > 0 ? ' · rev' : ''}
                  {!pr.preservesPitch ? ' · ♪' : ''}
                </span>
              </button>
              {!pr.builtIn && (
                <button type="button" className="preset__del" aria-label={t('speed.deletePreset')} title={t('speed.deletePreset')} onClick={() => deletePreset(pr.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        {naming ? (
          <form
            className="preset-save"
            onSubmit={(e) => {
              e.preventDefault()
              savePreset()
            }}
          >
            <input className="input" autoFocus placeholder={t('speed.presetName')} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn--primary">
              <span>{t('common.save')}</span>
            </button>
          </form>
        ) : (
          <button type="button" className="btn btn--secondary btn--block" onClick={() => setNaming(true)}>
            <Save size={16} />
            <span>{t('speed.savePreset')}</span>
          </button>
        )}
        {currentId && (
          <button type="button" className="btn btn--ghost btn--block" onClick={() => useUi.getState().openExport(currentId)}>
            <FileAudio size={16} />
            <span>{t('exportFx.fromPanel')}</span>
          </button>
        )}
        {currentId && (
          <label className="bind-row">
            <Link size={15} />
            <span>{t('speed.bindTrack')}</span>
            <Toggle checked={!!trackPreset && trackPreset === activePresetId} onChange={bindToTrack} label={t('speed.bindTrack')} />
          </label>
        )}
      </section>
      </div>
    </div>
  )
}
