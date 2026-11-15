import { MoreHorizontal, Pencil, Play, Shuffle, Trash2, Wand2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutToggle, useLayout } from '@renderer/components/LayoutToggle'
import { MixCollage, mixGradient } from '@renderer/components/MixCard'
import { NoteBlock } from '@renderer/components/NoteBlock'
import { TrackView } from '@renderer/components/TrackGrid'
import { Button, IconButton } from '@renderer/components/ui'
import { evaluateSmart, kindOf } from '@renderer/lib/smart'
import { matchesQuery } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useStats } from '@renderer/store/stats'
import { useUi } from '@renderer/store/ui'

export function SmartPlaylistPage({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const pl = useLibrary((s) => s.smartPlaylists.find((p) => p.id === id))
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const history = useStats((s) => s.history)
  const search = useUi((s) => s.search)
  const [layout, setLayout] = useLayout('smart')
  // the rules re-run whenever the library, the history or the rules change
  const ids = useMemo(() => (pl ? evaluateSmart(pl, tracks, history, order) : []), [pl, tracks, history, order])
  const shown = useMemo(() => (search ? ids.filter((x) => matchesQuery(tracks[x], search)) : ids), [ids, tracks, search])

  if (!pl) return <div className="page" />
  const ui = useUi.getState()
  const rules = pl.rules
    .map((r) => {
      const kind = kindOf(r.field)
      const field = t(`smart.fields.${r.field}`)
      if (kind === 'bool') return `${field}: ${r.value === 'false' || r.op === 'isNot' ? t('smart.no') : t('smart.yes')}`
      const op = t(kind === 'days' ? `smart.daysOps.${r.op}` : `smart.ops.${r.op}`)
      return `${field} ${op} ${r.value}${kind === 'days' ? ` ${t('smart.days')}` : ''}`
    })
    .join(pl.match === 'any' ? ` ${t('smart.or')} ` : ' · ')
  const remove = (): void =>
    ui.askConfirm({
      title: t('smart.deleteTitle', { name: pl.name }),
      danger: true,
      onConfirm: () => {
        useLibrary.getState().deleteSmart(id)
        ui.navigate({ type: 'library' })
      }
    })

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <MixCollage ids={ids} gradient={mixGradient(`smart${pl.id}`)} size="lg" />
        <div className="playlist-hero__info">
          <span className="eyebrow">
            <Wand2 size={14} /> {t('smart.label')}
          </span>
          <h1>{pl.name}</h1>
          <p>{rules || t('smart.noRules')}</p>
          <p className="muted small">{t('common.tracks', { count: ids.length })}</p>
          <NoteBlock note={pl.note} title={t('notes.playlistTitle', { name: pl.name })} onSave={(v) => useLibrary.getState().saveSmart({ ...pl, note: v.trim() || undefined })} />
          <div className="playlist-hero__actions no-drag">
            <Button variant="primary" icon={<Play size={16} fill="currentColor" />} disabled={!ids.length} onClick={() => void usePlayer.getState().playQueue(ids, 0)}>
              {t('library.playAll')}
            </Button>
            <Button
              icon={<Shuffle size={16} />}
              disabled={!ids.length}
              onClick={() => {
                const p = usePlayer.getState()
                if (!p.shuffle) p.setShuffle(true)
                void p.playQueue(ids, Math.floor(Math.random() * ids.length))
              }}
            >
              {t('library.shuffle')}
            </Button>
            <Button icon={<Pencil size={16} />} onClick={() => ui.editSmart(pl)}>
              {t('smart.editRules')}
            </Button>
            <IconButton label="More" onClick={(e) => ui.openMenu(e.clientX, e.clientY, [{ label: t('menu.delete'), icon: <Trash2 size={16} />, danger: true, onClick: remove }])}>
              <MoreHorizontal size={20} />
            </IconButton>
            <div className="toolbar__spacer" />
            <LayoutToggle value={layout} onChange={setLayout} />
          </div>
        </div>
      </header>
      {ids.length ? <TrackView ids={shown} layout={layout} /> : <p className="muted pad">{t('smart.empty')}</p>}
    </div>
  )
}
