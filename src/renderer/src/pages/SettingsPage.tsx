import { Check, ExternalLink, Film, FolderOpen, ImagePlus, Pipette, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackgroundMode, DiscordStatus, ImportFormat, Language, ThemeId } from '@shared/types'
import { VisualizerModes } from '@renderer/components/NowPlaying'
import { Logo } from '@renderer/components/Sidebar'
import { UpdateSettings } from '@renderer/components/UpdatePanel'
import { Button, Cover, Segmented, Slider, Toggle } from '@renderer/components/ui'
import { formatRate, formatTime } from '@renderer/lib/format'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useDiscordStatus } from '@renderer/hooks/useDiscord'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'

const ACCENTS = ['#4f6bff', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#ffffff', '#0e1526']

const THEME_PREVIEW: Record<Exclude<ThemeId, 'system'>, { bg: string; side: string; surface: string; line: string; accent: string; bar: string }> = {
  snow: { bg: '#f2f4f8', side: '#ffffff', surface: '#ffffff', line: '#e3e8f1', accent: '#4f6bff', bar: '#ffffff' },
  midnight: { bg: '#071026', side: '#0b1735', surface: '#0e1c40', line: '#1d3166', accent: '#ffffff', bar: '#0a1530' },
  aurora: {
    bg: 'linear-gradient(135deg,#3b2a8f,#0f6b8f 55%,#8f2a6b)',
    side: 'rgba(255,255,255,.12)',
    surface: 'rgba(255,255,255,.14)',
    line: 'rgba(255,255,255,.22)',
    accent: '#9bb4ff',
    bar: 'rgba(255,255,255,.16)'
  }
}

function ThemePreview({ id }: { id: ThemeId }): React.JSX.Element {
  if (id === 'system') {
    return (
      <div className="theme-preview theme-preview--split">
        <ThemePreview id="snow" />
        <ThemePreview id="midnight" />
      </div>
    )
  }
  const c = THEME_PREVIEW[id]
  return (
    <div className="theme-preview" style={{ background: c.bg }}>
      <div className="theme-preview__side" style={{ background: c.side }}>
        <i style={{ background: c.accent }} />
        <i style={{ background: c.line }} />
        <i style={{ background: c.line }} />
      </div>
      <div className="theme-preview__main">
        {[0, 1, 2].map((k) => (
          <div key={k} className="theme-preview__row" style={{ background: c.surface }}>
            <b style={{ background: c.line }} />
          </div>
        ))}
      </div>
      <div className="theme-preview__bar" style={{ background: c.bar }}>
        <i style={{ background: c.accent }} />
      </div>
    </div>
  )
}

function Row(props: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="setting-row">
      <div>
        <strong>{props.title}</strong>
        {props.hint && <span>{props.hint}</span>}
      </div>
      <div className="setting-row__control">{props.children}</div>
    </div>
  )
}

function statusText(status: DiscordStatus, user: string | undefined, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (status === 'connected') return user ? t('settings.discord.status.connectedAs', { user }) : t('settings.discord.status.connected')
  return t(`settings.discord.status.${status}`)
}

function DiscordPreview(): React.JSX.Element {
  const { t } = useTranslation()
  const currentId = usePlayer((s) => s.currentId)
  const rate = usePlayer((s) => s.rate)
  const duration = usePlayer((s) => s.duration)
  const position = usePlayer((s) => s.position)
  const playing = usePlayer((s) => s.playing)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))
  const showSpeed = useSettings((s) => s.settings.discord.showSpeed)
  const speed = showSpeed && Math.abs(rate - 1) > 0.001 ? ` · ${formatRate(rate)}` : ''
  return (
    <div className="discord-preview">
      <span className="discord-preview__label">
        {t('settings.discord.listening')} <b>Velvet</b>
      </span>
      <div className="discord-preview__body">
        {track ? <Cover path={track.coverPath} seed={track.id} size={72} rounded={8} /> : <Logo size={72} />}
        <div className="discord-preview__text">
          <strong>{track ? trackTitle(track, t) : 'Velvet'}</strong>
          <span>
            {!playing && track ? `${t('player.pause')} · ` : ''}
            {track ? trackArtist(track, t) : t('player.nothing')}
          </span>
          <span className="muted">
            {track?.album || (track ? trackTitle(track, t) : '')}
            {speed}
          </span>
          {track && duration > 0 && playing && (
            <div className="discord-preview__time">
              <small>{formatTime(position / rate)}</small>
              <div className="discord-preview__bar">
                <i style={{ width: `${(position / duration) * 100}%` }} />
              </div>
              <small>{formatTime(duration / rate)}</small>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const s = useSettings((st) => st.settings)
  const { set, setSection, reset } = useSettings.getState()
  const preservesPitch = usePlayer((st) => st.preservesPitch)
  const [status, user] = useDiscordStatus()
  const [version, setVersion] = useState('')
  const askConfirm = useUi((st) => st.askConfirm)

  useEffect(() => {
    void window.velvet.app.info().then((i) => setVersion(i.version))
  }, [])

  const themes: ThemeId[] = ['snow', 'midnight', 'aurora', 'system']
  const isCustomAccent = s.accent !== '' && !ACCENTS.includes(s.accent)

  return (
    <div className="page page--narrow settings">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('settings.title')}</h1>
        </div>
      </header>

      <section className="card">
        <h2 className="card__title">{t('settings.sections.appearance')}</h2>
        <h4 className="label">{t('settings.appearance.theme')}</h4>
        <div className="theme-grid">
          {themes.map((id) => (
            <button key={id} type="button" className={`theme-card ${s.theme === id ? 'is-active' : ''}`} onClick={() => set({ theme: id })}>
              <ThemePreview id={id} />
              <span className="theme-card__name">
                {t(`settings.appearance.themes.${id}.name`)}
                {s.theme === id && <Check size={15} />}
              </span>
              <span className="theme-card__desc">{t(`settings.appearance.themes.${id}.desc`)}</span>
            </button>
          ))}
        </div>

        <h4 className="label">{t('settings.appearance.accent')}</h4>
        <div className="swatches">
          <button
            type="button"
            className={`swatch swatch--theme ${s.accent === '' ? 'is-active' : ''}`}
            onClick={() => set({ accent: '' })}
            title={t('settings.appearance.accentTheme')}
          >
            <span>{t('settings.appearance.accentTheme')}</span>
          </button>
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${s.accent === c ? 'is-active' : ''}`}
              style={{ background: c }}
              onClick={() => set({ accent: c })}
              aria-label={c}
            />
          ))}
          <label className={`swatch swatch--picker ${isCustomAccent ? 'is-active' : ''}`} title={t('settings.appearance.accentCustom')} style={isCustomAccent ? { background: s.accent } : undefined}>
            <Pipette size={15} />
            <input type="color" value={s.accent || '#4f6bff'} onChange={(e) => set({ accent: e.target.value })} />
          </label>
        </div>
        <Row title={t('settings.appearance.accentFromCover')}>
          <Toggle checked={s.accentFromCover} onChange={(v) => set({ accentFromCover: v })} label={t('settings.appearance.accentFromCover')} />
        </Row>
        <Row title={t('settings.appearance.radius')}>
          <Slider label={t('settings.appearance.radius')} min={0} max={24} step={1} value={s.radius} onChange={(v) => set({ radius: v })} formatValue={(v) => `${v}px`} />
          <output>{s.radius}px</output>
        </Row>
        <Row title={t('settings.appearance.fontScale')}>
          <Slider label={t('settings.appearance.fontScale')} min={0.85} max={1.25} step={0.05} value={s.fontScale} onChange={(v) => set({ fontScale: v })} formatValue={(v) => `${Math.round(v * 100)}%`} />
          <output>{Math.round(s.fontScale * 100)}%</output>
        </Row>
        <Row title={t('settings.appearance.density')}>
          <Segmented
            label={t('settings.appearance.density')}
            value={s.density}
            onChange={(v) => set({ density: v })}
            options={[
              { value: 'compact', label: t('settings.appearance.compact') },
              { value: 'comfortable', label: t('settings.appearance.comfortable') }
            ]}
          />
        </Row>
        <h4 className="label">{t('settings.appearance.background')}</h4>
        <Segmented<BackgroundMode>
          label={t('settings.appearance.background')}
          value={s.backgroundMode}
          onChange={(v) => set({ backgroundMode: v })}
          options={[
            { value: 'none', label: t('settings.appearance.bg.none') },
            { value: 'cover', label: t('settings.appearance.bg.cover') },
            { value: 'image', label: t('settings.appearance.bg.image') },
            { value: 'video', label: t('settings.appearance.bg.video') }
          ]}
        />
        {s.backgroundMode === 'cover' && (
          <>
            <Row title={t('settings.appearance.liveIntensity')} hint={t('settings.appearance.liveHint')}>
              <Slider label={t('settings.appearance.liveIntensity')} min={0.2} max={1} step={0.05} value={s.liveIntensity} onChange={(v) => set({ liveIntensity: v })} />
              <output>{Math.round(s.liveIntensity * 100)}%</output>
            </Row>
            <Row title={t('settings.appearance.liveReactive')}>
              <Toggle checked={s.liveReactive} onChange={(v) => set({ liveReactive: v })} label={t('settings.appearance.liveReactive')} />
            </Row>
          </>
        )}
        {s.backgroundMode === 'image' && (
          <Row title={t('settings.appearance.bg.image')}>
            {s.backgroundImage && <Cover path={s.backgroundImage} seed="bg" size={40} rounded={8} />}
            <Button
              icon={<ImagePlus size={16} />}
              onClick={async () => {
                const p = await window.velvet.covers.pick()
                if (p) set({ backgroundImage: p })
              }}
            >
              {t('settings.appearance.chooseImage')}
            </Button>
            {s.backgroundImage && (
              <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => set({ backgroundImage: '' })}>
                {t('settings.appearance.removeImage')}
              </Button>
            )}
          </Row>
        )}
        {s.backgroundMode === 'video' && (
          <Row title={t('settings.appearance.bg.video')} hint={s.backgroundVideo || t('settings.appearance.videoHint')}>
            <Button
              icon={<Film size={16} />}
              onClick={async () => {
                const p = await window.velvet.dialog.pickVideo()
                if (p) set({ backgroundVideo: p })
              }}
            >
              {t('settings.appearance.chooseVideo')}
            </Button>
          </Row>
        )}
        {s.backgroundMode !== 'none' && (
          <>
            <Row title={t('settings.appearance.blur')}>
              <Slider label={t('settings.appearance.blur')} min={0} max={80} step={1} value={s.backgroundBlur} onChange={(v) => set({ backgroundBlur: v })} />
              <output>{s.backgroundBlur}px</output>
            </Row>
            <Row title={t('settings.appearance.dim')}>
              <Slider label={t('settings.appearance.dim')} min={0} max={0.9} step={0.05} value={s.backgroundDim} onChange={(v) => set({ backgroundDim: v })} />
              <output>{Math.round(s.backgroundDim * 100)}%</output>
            </Row>
          </>
        )}
        <Row title={t('visualizer.mode')}>
          <VisualizerModes />
        </Row>
        <Row title={t('settings.appearance.animations')}>
          <Toggle checked={s.animations} onChange={(v) => set({ animations: v })} label={t('settings.appearance.animations')} />
        </Row>
        <div className="card__foot">
          <Button variant="ghost" icon={<RotateCcw size={16} />} onClick={reset}>
            {t('settings.appearance.reset')}
          </Button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">{t('settings.sections.language')}</h2>
        <Row title={t('settings.language.label')}>
          <Segmented<Language>
            label={t('settings.language.label')}
            value={s.language}
            onChange={(v) => set({ language: v })}
            options={[
              { value: 'ru', label: 'Русский' },
              { value: 'en', label: 'English' }
            ]}
          />
        </Row>
      </section>

      <section className="card">
        <h2 className="card__title">{t('settings.sections.playback')}</h2>
        <Row title={t('settings.playback.crossfade')} hint={t('settings.playback.crossfadeHint')}>
          <Slider
            label={t('settings.playback.crossfade')}
            min={0}
            max={12}
            step={0.5}
            value={s.playback.crossfade}
            onChange={(v) => setSection('playback', { crossfade: v })}
            formatValue={(v) => (v ? `${v} s` : t('settings.playback.crossfadeOff'))}
          />
          <output>{s.playback.crossfade ? `${s.playback.crossfade} s` : t('settings.playback.crossfadeOff')}</output>
        </Row>
        <Row title={t('settings.playback.gapless')} hint={t('settings.playback.gaplessHint')}>
          <Toggle checked={s.playback.gapless} onChange={(v) => setSection('playback', { gapless: v })} label={t('settings.playback.gapless')} />
        </Row>
        <Row title={t('settings.playback.autoPitch')} hint={t('settings.playback.autoPitchHint')}>
          <Toggle checked={preservesPitch} onChange={(v) => usePlayer.getState().setPreservesPitch(v)} label={t('settings.playback.autoPitch')} />
        </Row>
        {s.customPresets.length > 0 && (
          <Row title={t('settings.playback.clearPresets')}>
            <Button
              variant="ghost"
              icon={<Trash2 size={16} />}
              onClick={() => askConfirm({ title: t('settings.playback.clearPresetsConfirm'), danger: true, onConfirm: () => set({ customPresets: [] }) })}
            >
              {t('common.delete')}
            </Button>
          </Row>
        )}
        <h4 className="label">{t('settings.desktop.title')}</h4>
        <Row title={t('settings.desktop.closeToTray')} hint={t('settings.desktop.closeToTrayHint')}>
          <Toggle checked={s.desktop.closeToTray} onChange={(v) => setSection('desktop', { closeToTray: v })} label={t('settings.desktop.closeToTray')} />
        </Row>
        <Row title={t('settings.desktop.notifications')} hint={t('settings.desktop.notificationsHint')}>
          <Toggle checked={s.desktop.notifications} onChange={(v) => setSection('desktop', { notifications: v })} label={t('settings.desktop.notifications')} />
        </Row>
        <Row title={t('settings.desktop.miniOnTop')}>
          <Toggle checked={s.desktop.miniOnTop} onChange={(v) => setSection('desktop', { miniOnTop: v })} label={t('settings.desktop.miniOnTop')} />
        </Row>
        <Row title={t('settings.desktop.globalShortcuts')} hint={t('settings.desktop.globalShortcutsHint')}>
          <Toggle checked={s.desktop.globalShortcuts} onChange={(v) => setSection('desktop', { globalShortcuts: v })} label={t('settings.desktop.globalShortcuts')} />
        </Row>
        <h4 className="label">{t('settings.playback.shortcuts')}</h4>
        <div className="shortcuts">
          {[
            ['Space', t('settings.playback.keys.play')],
            ['← / →', t('settings.playback.keys.seek')],
            ['↑ / ↓', t('settings.playback.keys.volume')],
            ['Ctrl + ← / →', t('settings.playback.keys.track')],
            ['[ / ]', t('settings.playback.keys.speed')],
            ['Ctrl + F', t('settings.playback.keys.search')],
            ['Ctrl + Alt + Space', t('settings.desktop.keyGlobalPlay')],
            ['Ctrl + Alt + ← / →', t('settings.desktop.keyGlobalTrack')],
            ['Ctrl + Alt + ↑ / ↓', t('settings.desktop.keyGlobalVolume')]
          ].map(([k, label]) => (
            <div key={k} className="shortcut">
              <kbd>{k}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">{t('settings.sections.discord')}</h2>
        <Row title={t('settings.discord.enable')} hint={t('settings.discord.enableHint')}>
          <span className={`status status--${status}`}>{statusText(status, user, t)}</span>
          <Toggle checked={s.discord.enabled} onChange={(v) => setSection('discord', { enabled: v })} label={t('settings.discord.enable')} />
        </Row>
        <div className="discord-grid">
          <div className="discord-grid__form">
            <label className="field">
              <span className="field__label">{t('settings.discord.clientId')}</span>
              <input
                className="input"
                inputMode="numeric"
                value={s.discord.clientId}
                placeholder={t('settings.discord.clientIdPlaceholder')}
                onChange={(e) => setSection('discord', { clientId: e.target.value.replace(/\D/g, '') })}
              />
            </label>
            <details className="howto" open={!s.discord.clientId}>
              <summary>{t('settings.discord.howto')}</summary>
              <ol>
                {(t('settings.discord.steps', { returnObjects: true }) as string[]).map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <Button icon={<ExternalLink size={15} />} onClick={() => void window.velvet.app.openExternal('https://discord.com/developers/applications')}>
                {t('settings.discord.openPortal')}
              </Button>
            </details>
          </div>
          <div>
            <h4 className="label">{t('settings.discord.preview')}</h4>
            <DiscordPreview />
          </div>
        </div>
        <Row title={t('settings.discord.showSpeed')}>
          <Toggle checked={s.discord.showSpeed} onChange={(v) => setSection('discord', { showSpeed: v })} label={t('settings.discord.showSpeed')} />
        </Row>
        <Row title={t('settings.discord.showButtons')}>
          <Toggle checked={s.discord.showButtons} onChange={(v) => setSection('discord', { showButtons: v })} label={t('settings.discord.showButtons')} />
        </Row>
        <Row title={t('settings.discord.lookupCovers')}>
          <Toggle checked={s.discord.lookupCovers} onChange={(v) => setSection('discord', { lookupCovers: v })} label={t('settings.discord.lookupCovers')} />
        </Row>
      </section>

      <section className="card">
        <h2 className="card__title">{t('settings.sections.import')}</h2>
        <Row title={t('settings.importer.downloadDir')} hint={s.importer.downloadDir}>
          <Button
            icon={<FolderOpen size={16} />}
            onClick={async () => {
              const dir = await window.velvet.dialog.pickDir()
              if (dir) setSection('importer', { downloadDir: dir })
            }}
          >
            {t('settings.importer.change')}
          </Button>
        </Row>
        <Row title={t('settings.importer.format')}>
          <select className="input input--select" value={s.importer.format} onChange={(e) => setSection('importer', { format: e.target.value as ImportFormat })}>
            {(['mp3', 'm4a', 'best'] as const).map((f) => (
              <option key={f} value={f}>
                {t(`settings.importer.formats.${f}`)}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t('settings.importer.createPlaylist')}>
          <Toggle checked={s.importer.createPlaylist} onChange={(v) => setSection('importer', { createPlaylist: v })} label={t('settings.importer.createPlaylist')} />
        </Row>
        <h4 className="label">{t('settings.importer.spotifyApi')}</h4>
        <p className="muted small">{t('settings.importer.spotifyApiHint')}</p>
        <div className="two-cols">
          <label className="field">
            <span className="field__label">{t('settings.importer.clientId')}</span>
            <input className="input" value={s.importer.spotifyClientId} onChange={(e) => setSection('importer', { spotifyClientId: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span className="field__label">{t('settings.importer.clientSecret')}</span>
            <input className="input" type="password" value={s.importer.spotifyClientSecret} onChange={(e) => setSection('importer', { spotifyClientSecret: e.target.value.trim() })} />
          </label>
        </div>
      </section>

      <section className="card">
        <div className="about">
          <Logo size={44} />
          <div>
            <strong>Velvet</strong>
            <span className="muted">{t('settings.about.version', { version })}</span>
            <p className="muted small">{t('settings.about.text')}</p>
          </div>
        </div>
        <UpdateSettings />
      </section>
    </div>
  )
}
