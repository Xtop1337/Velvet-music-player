import { BarChart3, Heart, Library, Link2, ListMusic, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Playlist } from '@shared/types'
import { addToPlaylistToast } from '@renderer/lib/trackMenu'
import { TRACK_DRAG_TYPE } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { useImports } from '@renderer/store/imports'
import { useUi } from '@renderer/store/ui'
import { Cover, IconButton } from './ui'
import { UpdateBanner } from './UpdatePanel'

export function Logo({ size = 28 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <defs>
        <linearGradient id="vlv" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--logo-a)" />
          <stop offset="1" stopColor="var(--logo-b)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#vlv)" />
      <path d="M9 10.5 L16 23 L23 10.5" fill="none" stroke="var(--logo-fg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="9.5" r="1.8" fill="var(--logo-fg)" />
    </svg>
  )
}

function PlaylistCover({ playlist }: { playlist: Playlist }): React.JSX.Element {
  const tracks = useLibrary((s) => s.tracks)
  const first = playlist.trackIds.map((id) => tracks[id]).find((t) => t?.coverPath)
  return <Cover path={playlist.coverPath ?? first?.coverPath} seed={playlist.id} size={32} rounded={8} />
}

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const view = useUi((s) => s.view)
  const navigate = useUi((s) => s.navigate)
  const askText = useUi((s) => s.askText)
  const askConfirm = useUi((s) => s.askConfirm)
  const openMenu = useUi((s) => s.openMenu)
  const playlists = useLibrary((s) => s.playlists)
  const activeJobs = useImports((s) => s.jobs.filter((j) => j.state === 'resolving' || j.state === 'downloading').length)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const likedCount = useLibrary((s) => s.order.reduce((n, id) => n + (s.tracks[id]?.liked ? 1 : 0), 0))

  const newPlaylist = (): void =>
    askText({
      title: t('playlist.namePrompt'),
      value: '',
      placeholder: t('playlist.namePlaceholder'),
      onSubmit: (name) => {
        const id = useLibrary.getState().createPlaylist(name.trim() || t('playlist.defaultName'))
        navigate({ type: 'playlist', id })
      }
    })

  const playlistMenu = (p: Playlist, e: React.MouseEvent): void => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, [
      {
        label: t('menu.rename'),
        icon: <Pencil size={16} />,
        onClick: () =>
          askText({ title: t('menu.rename'), value: p.name, onSubmit: (v) => v.trim() && useLibrary.getState().renamePlaylist(p.id, v.trim()) })
      },
      {
        label: t('menu.changeCover'),
        icon: <ListMusic size={16} />,
        onClick: async () => {
          const path = await window.velvet.covers.pick()
          if (path) useLibrary.getState().setPlaylistCover(p.id, path)
        }
      },
      ...(p.coverPath
        ? [{ label: t('menu.removeCover'), onClick: () => useLibrary.getState().setPlaylistCover(p.id, undefined) }]
        : []),
      { separator: true },
      {
        label: t('menu.delete'),
        icon: <Trash2 size={16} />,
        danger: true,
        onClick: () =>
          askConfirm({
            title: t('playlist.deleteConfirm', { name: p.name }),
            text: t('playlist.deleteText'),
            danger: true,
            onConfirm: () => {
              useLibrary.getState().deletePlaylist(p.id)
              if (view.type === 'playlist' && view.id === p.id) navigate({ type: 'library' })
            }
          })
      }
    ])
  }

  const nav = [
    { key: 'library', icon: <Library size={19} />, label: t('nav.library'), view: { type: 'library' } as const },
    { key: 'liked', icon: <Heart size={19} />, label: t('nav.liked'), view: { type: 'liked' } as const, badge: likedCount || undefined, quiet: true },
    { key: 'stats', icon: <BarChart3 size={19} />, label: t('nav.stats'), view: { type: 'stats' } as const },
    { key: 'search', icon: <Search size={19} />, label: t('nav.search'), view: { type: 'search' } as const },
    { key: 'import', icon: <Link2 size={19} />, label: t('nav.import'), view: { type: 'import' } as const, badge: activeJobs || undefined },
    { key: 'settings', icon: <Settings size={19} />, label: t('nav.settings'), view: { type: 'settings' } as const }
  ]

  return (
    <aside className="sidebar">
      <div className="sidebar__brand drag">
        <Logo />
        <span className="brand-name">Velvet</span>
      </div>
      <nav className="sidebar__nav">
        {nav.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`nav-item ${view.type === n.key ? 'is-active' : ''} ${dropTarget === n.key ? 'is-drop' : ''}`}
            onClick={() => navigate(n.view)}
            onDragOver={(e) => {
              if (n.key !== 'liked' || !e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) return
              e.preventDefault()
              setDropTarget('liked')
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              setDropTarget(null)
              const raw = n.key === 'liked' ? e.dataTransfer.getData(TRACK_DRAG_TYPE) : ''
              if (!raw) return
              const now = Date.now()
              for (const id of JSON.parse(raw) as string[]) useLibrary.getState().updateTrack(id, { liked: true, likedAt: now })
            }}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.badge && <span className={`nav-badge ${'quiet' in n && n.quiet ? 'nav-badge--quiet' : ''}`}>{n.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar__section">
        <span>{t('nav.playlists')}</span>
        <IconButton label={t('nav.newPlaylist')} size="sm" onClick={newPlaylist}>
          <Plus size={17} />
        </IconButton>
      </div>
      <div className="sidebar__playlists">
        {playlists.length === 0 && <p className="sidebar__hint">{t('nav.noPlaylists')}</p>}
        {playlists.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`playlist-item ${view.type === 'playlist' && view.id === p.id ? 'is-active' : ''} ${dropTarget === p.id ? 'is-drop' : ''}`}
            onClick={() => navigate({ type: 'playlist', id: p.id })}
            onContextMenu={(e) => playlistMenu(p, e)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDropTarget(p.id)
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              setDropTarget(null)
              const raw = e.dataTransfer.getData(TRACK_DRAG_TYPE)
              if (!raw) return
              e.preventDefault()
              e.stopPropagation()
              addToPlaylistToast(p.id, JSON.parse(raw) as string[], t)
            }}
          >
            <PlaylistCover playlist={p} />
            <span className="playlist-item__text">
              <span className="playlist-item__name">{p.name}</span>
              <span className="playlist-item__meta">{t('common.tracks', { count: p.trackIds.length })}</span>
            </span>
          </button>
        ))}
      </div>
      <UpdateBanner />
    </aside>
  )
}
