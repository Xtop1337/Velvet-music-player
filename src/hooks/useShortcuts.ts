import { useEffect } from 'react'
import { actionFor, comboFromEvent, type LocalAction } from '@shared/hotkeys'
import { engine } from '@renderer/audio/engine'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'

export const isMac = navigator.platform.toLowerCase().includes('mac')

function editing(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

const HANDLERS: Record<LocalAction, () => void> = {
  playPause: () => void usePlayer.getState().toggle(),
  next: () => void usePlayer.getState().next(),
  prev: () => void usePlayer.getState().prev(),
  seekForward: () => usePlayer.getState().seek(engine.currentTime + 5),
  seekBackward: () => usePlayer.getState().seek(engine.currentTime - 5),
  volumeUp: () => usePlayer.getState().setVolume(usePlayer.getState().volume + 0.05),
  volumeDown: () => usePlayer.getState().setVolume(usePlayer.getState().volume - 0.05),
  mute: () => usePlayer.getState().toggleMute(),
  speedUp: () => usePlayer.getState().setRate(usePlayer.getState().rate + 0.05),
  speedDown: () => usePlayer.getState().setRate(usePlayer.getState().rate - 0.05),
  speedReset: () => usePlayer.getState().setRate(1),
  like: () => {
    const id = usePlayer.getState().currentId
    if (id) useLibrary.getState().toggleLike(id)
  },
  shuffle: () => usePlayer.getState().setShuffle(!usePlayer.getState().shuffle),
  repeat: () => usePlayer.getState().cycleRepeat(),
  search: () => {
    const ui = useUi.getState()
    if (ui.nowPlayingOpen) ui.setNowPlaying(false)
    if (ui.view.type !== 'library' && ui.view.type !== 'playlist' && ui.view.type !== 'liked') ui.navigate({ type: 'library' })
    window.setTimeout(() => document.getElementById('global-search')?.focus(), 30)
  },
  visualizer: () => {
    const ui = useUi.getState()
    if (ui.nowPlayingOpen) ui.setNowPlaying(false)
    else if (usePlayer.getState().currentId) ui.setNowPlaying(true)
  },
  fullscreen: () => {
    const ui = useUi.getState()
    if (!ui.nowPlayingOpen) {
      if (!usePlayer.getState().currentId) return
      ui.setNowPlaying(true)
      // let the screen mount before asking it to go fullscreen
      window.setTimeout(() => window.dispatchEvent(new Event('velvet:fullscreen')), 60)
      return
    }
    window.dispatchEvent(new Event('velvet:fullscreen'))
  },
  miniPlayer: () => void window.velvet.remote.toggleMini()
}

/** Runs the user's in-app shortcuts (Settings → Hotkeys). */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // the hotkey editor is recording a new combination
      if (document.body.dataset.recordingHotkey) return
      const target = e.target as HTMLElement | null
      const combo = comboFromEvent(e)
      if (!combo) return
      const plain = !combo.includes('+')
      if (plain && editing(target)) return
      // dialogs and menus on top keep their own keys
      if (useUi.getState().tagEditorId || useUi.getState().prompt || useUi.getState().exportId || document.querySelector('.modal-scrim')) return
      const action = actionFor(useSettings.getState().settings.hotkeys.local, combo, isMac)
      if (!action) return
      // Space / Enter on a focused button already "click" it
      if (plain && (combo === 'Space' || combo === 'Enter') && target?.closest('button, [role="button"], a')) return
      // a focused slider uses the arrow keys itself
      if (plain && combo.startsWith('Arrow') && target?.matches('input[type="range"]')) return
      e.preventDefault()
      e.stopPropagation()
      HANDLERS[action]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
