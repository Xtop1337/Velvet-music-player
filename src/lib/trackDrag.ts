import i18n from 'i18next'
import { create } from 'zustand'
import { useLibrary } from '@renderer/store/library'
import { addToPlaylistToast } from './trackMenu'

/**
 * Dragging tracks onto "Liked", onto a playlist, or within a playlist to reorder.
 *
 * Built on pointer events rather than HTML5 drag & drop: in the Tauri window on Windows the
 * native drop target is taken by the window itself (that is how dropped files arrive with their
 * paths), and HTML5 drag & drop inside the page stops working there.
 *
 * Drop targets are plain elements with `data-drop`:
 *   "liked"            → like the tracks
 *   "pl:<id>"          → add the tracks to a playlist
 *   "row:<pl>:<index>" → move the dragged playlist row before this one
 */

export interface TrackDrag {
  ids: string[]
  /** set when the rows come from a playlist and can be reordered there */
  playlistId?: string
  from?: number
}

interface DragState {
  drag: TrackDrag | null
  /** the `data-drop` key under the pointer, if it accepts the drag */
  over: string | null
}

export const useTrackDrag = create<DragState>(() => ({ drag: null, over: null }))

const THRESHOLD = 5

function accepts(key: string, d: TrackDrag): boolean {
  if (key === 'liked' || key.startsWith('pl:')) return true
  if (key.startsWith('row:')) {
    const [, pl] = key.split(':')
    return !!d.playlistId && pl === d.playlistId && d.from !== undefined
  }
  return false
}

function targetAt(x: number, y: number, d: TrackDrag): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]')
  const key = el?.dataset.drop
  return key && accepts(key, d) ? key : null
}

function drop(key: string, d: TrackDrag): void {
  const lib = useLibrary.getState()
  if (key === 'liked') {
    const now = Date.now()
    for (const id of d.ids) lib.updateTrack(id, { liked: true, likedAt: now })
  } else if (key.startsWith('pl:')) {
    addToPlaylistToast(key.slice(3), d.ids, i18n.t)
  } else if (key.startsWith('row:') && d.playlistId && d.from !== undefined) {
    const to = Number(key.split(':')[2])
    if (to !== d.from) lib.movePlaylistTrack(d.playlistId, d.from, d.from < to ? to - 1 : to)
  }
}

/** A copy of the row that follows the pointer, like the browser's own drag image. */
function makeGhost(row: HTMLElement): HTMLElement {
  const r = row.getBoundingClientRect()
  const cs = getComputedStyle(row)
  const ghost = row.cloneNode(true) as HTMLElement
  ghost.classList.add('drag-ghost')
  ghost.removeAttribute('data-drop')
  Object.assign(ghost.style, {
    width: `${r.width}px`,
    height: `${r.height}px`,
    gridTemplateColumns: cs.gridTemplateColumns
  })
  document.body.appendChild(ghost)
  return ghost
}

/** Call from a row's onPointerDown; the drag starts once the pointer moves a few pixels. */
export function beginTrackDrag(e: React.PointerEvent<HTMLElement>, payload: () => TrackDrag): void {
  if (e.button !== 0 || e.pointerType === 'touch') return
  if ((e.target as HTMLElement).closest('button, input, a, select, textarea')) return
  const row = e.currentTarget
  const x0 = e.clientX
  const y0 = e.clientY
  let ghost: HTMLElement | null = null
  let dx = 0
  let dy = 0
  let d: TrackDrag | null = null

  const move = (ev: PointerEvent): void => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return
      const r = row.getBoundingClientRect()
      dx = x0 - r.left
      dy = y0 - r.top
      d = payload()
      ghost = makeGhost(row)
      document.documentElement.classList.add('is-dragging-tracks')
      window.getSelection()?.removeAllRanges()
      useTrackDrag.setState({ drag: d, over: null })
    }
    ghost.style.transform = `translate(${ev.clientX - dx}px, ${ev.clientY - dy}px)`
    const over = targetAt(ev.clientX, ev.clientY, d!)
    if (over !== useTrackDrag.getState().over) useTrackDrag.setState({ over })
  }

  const finish = (ev: PointerEvent | null): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', esc, true)
    if (!ghost) return
    ghost.remove()
    document.documentElement.classList.remove('is-dragging-tracks')
    const key = ev && d ? targetAt(ev.clientX, ev.clientY, d) : null
    useTrackDrag.setState({ drag: null, over: null })
    // the pointer was released somewhere else: that must not count as a click there
    const swallow = (c: MouseEvent): void => {
      c.stopPropagation()
      c.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    if (key && d) drop(key, d)
  }
  const up = (ev: PointerEvent): void => finish(ev)
  const cancel = (): void => finish(null)
  const esc = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !ghost) return
    ev.stopPropagation()
    finish(null)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', esc, true)
}
