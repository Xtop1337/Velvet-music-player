import { Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Backdrop } from './components/Backdrop'
import { NowPlaying } from './components/NowPlaying'
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts } from './components/Overlays'
import { PlayerBar } from './components/PlayerBar'
import { QueuePanel } from './components/QueuePanel'
import { Sidebar } from './components/Sidebar'
import { TagEditor } from './components/TagEditor'
import { ExportDialog } from './components/ExportDialog'
import { useDiscordSync } from './hooks/useDiscord'
import { useMediaSession } from './hooks/useMediaSession'
import { useRemote } from './hooks/useRemote'
import { useUpdates } from './hooks/useUpdates'
import { useShortcuts } from './hooks/useShortcuts'
import { useTheme } from './hooks/useTheme'
import { addDropped } from './lib/addMusic'
import { TRACK_DRAG_TYPE } from './lib/tracks'
import { ImportPage } from './pages/ImportPage'
import { LibraryPage } from './pages/LibraryPage'
import { PlaylistPage } from './pages/PlaylistPage'
import { SettingsPage } from './pages/SettingsPage'
import { AlbumPage, ArtistPage } from './pages/AlbumArtistPages'
import { LikedPage } from './pages/LikedPage'
import { StatsPage } from './pages/StatsPage'
import { SearchPage } from './pages/SearchPage'
import { useStats } from './store/stats'
import { bindImportEvents } from './store/imports'
import { useLibrary } from './store/library'
import { usePlayer } from './store/player'
import { useSettings } from './store/settings'
import { useUi } from './store/ui'

function ScanProgress(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [p, setP] = useState<{ done: number; total: number } | null>(null)
  useEffect(() => {
    let timer: number | null = null
    const off = window.velvet.library.onScanProgress((done, total) => {
      setP({ done, total })
      if (timer) clearTimeout(timer)
      if (done >= total) timer = window.setTimeout(() => setP(null), 600)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])
  if (!p || p.total < 3) return null
  return (
    <div className="scan-progress">
      <span>{t('library.scanning', { done: p.done, total: p.total })}</span>
      <div className="job__bar">
        <i style={{ width: `${(p.done / p.total) * 100}%` }} />
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const view = useUi((s) => s.view)
  const loaded = useSettings((s) => s.loaded)
  const language = useSettings((s) => s.settings.language)
  const libLoaded = useLibrary((s) => s.loaded)
  const [platform, setPlatform] = useState('win32')
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    void window.velvet.app.info().then((i) => setPlatform(i.platform))
    void useSettings
      .getState()
      .load()
      .then(() => usePlayer.getState().init(useSettings.getState().settings.playback))
    void useStats.getState().load()
    void useLibrary
      .getState()
      .load()
      .then(() => usePlayer.getState().restore())
    return bindImportEvents((job) => {
      const ui = useUi.getState()
      if (job.state === 'done') ui.toast(t('import.finished', { title: job.title ?? job.url }), 'success')
      else {
        const error = t(`import.errors.${job.error}`, { defaultValue: job.error ?? '' })
        ui.toast(t('import.finishedError', { error: error.length > 140 ? `${error.slice(0, 140)}…` : error }), 'error')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void i18n.changeLanguage(language)
  }, [language, i18n])

  useTheme()
  useDiscordSync()
  useMediaSession()
  useShortcuts()
  useRemote()
  useUpdates()

  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(TRACK_DRAG_TYPE)

  return (
    <div
      className={`app platform-${platform} ${loaded && libLoaded ? 'is-ready' : ''}`}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragOver={(e) => {
        if (isFileDrag(e)) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void addDropped(e.dataTransfer.files, t)
      }}
    >
      <div className="app__bg" aria-hidden>
        <div className="aurora">
          <i />
          <i />
          <i />
        </div>
        <Backdrop />
      </div>
      <Sidebar />
      <main className="main">
        <div className="titlebar-spacer drag" />
        {view.type === 'library' && <LibraryPage />}
        {view.type === 'playlist' && <PlaylistPage key={view.id} id={view.id} />}
        {view.type === 'import' && <ImportPage />}
        {view.type === 'settings' && <SettingsPage />}
        {view.type === 'liked' && <LikedPage />}
        {view.type === 'stats' && <StatsPage />}
        {view.type === 'search' && <SearchPage />}
        {view.type === 'album' && <AlbumPage key={view.album} album={view.album} artist={view.artist} />}
        {view.type === 'artist' && <ArtistPage key={view.artist} artist={view.artist} />}
      </main>
      <QueuePanel />
      <PlayerBar />
      <NowPlaying />
      <TagEditor />
      <ExportDialog />
      <PromptDialog />
      <ConfirmDialog />
      <ContextMenu />
      <ScanProgress />
      <Toasts />
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Download size={36} />
            <span>{t('library.dropHere')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
