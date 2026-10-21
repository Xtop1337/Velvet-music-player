import { useEffect } from 'react'
import { engine } from '@renderer/audio/engine'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const ui = useUi.getState()
        if (ui.view.type !== 'library' && ui.view.type !== 'playlist') ui.navigate({ type: 'library' })
        window.setTimeout(() => document.getElementById('global-search')?.focus(), 30)
        return
      }
      if (typing(e) || useUi.getState().tagEditorId || useUi.getState().prompt) return
      const p = usePlayer.getState()
      if (e.code === 'Space') {
        if ((e.target as HTMLElement)?.tagName === 'BUTTON') return
        e.preventDefault()
        void p.toggle()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (mod) void p.next()
        else p.seek(engine.currentTime + 5)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (mod) void p.prev()
        else p.seek(engine.currentTime - 5)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        p.setVolume(p.volume + 0.05)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        p.setVolume(p.volume - 0.05)
      } else if (e.key === ']') {
        p.setRate(p.rate + 0.05)
      } else if (e.key === '[') {
        p.setRate(p.rate - 0.05)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
