import { describe, expect, it } from 'vitest'
import {
  actionFor,
  comboFromEvent,
  comboParts,
  DEFAULT_LOCAL_HOTKEYS,
  findConflict,
  globalAllowed,
  mergeHotkeys,
  portableCombo,
  resolveCombo,
  toAccelerator
} from '@shared/hotkeys'

const ev = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...m
})

describe('hotkeys', () => {
  it('reads physical keys, so shortcuts work on any layout', () => {
    // pressing the "F" key on a Russian layout still has code KeyF
    expect(comboFromEvent(ev('KeyF'))).toBe('KeyF')
    expect(comboFromEvent(ev('ArrowRight', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+ArrowRight')
    expect(comboFromEvent(ev('ControlLeft', { ctrlKey: true }))).toBeNull()
  })
  it('maps Mod to Ctrl / Cmd', () => {
    expect(resolveCombo('Mod+ArrowRight', false)).toBe('Ctrl+ArrowRight')
    expect(resolveCombo('Shift+Mod+KeyM', true)).toBe('Shift+Meta+KeyM')
    expect(portableCombo('Ctrl+Alt+KeyL', false)).toBe('Mod+Alt+KeyL')
    expect(actionFor(DEFAULT_LOCAL_HOTKEYS, 'Ctrl+ArrowRight', false)).toBe('next')
    expect(actionFor(DEFAULT_LOCAL_HOTKEYS, 'Meta+ArrowRight', true)).toBe('next')
    expect(actionFor(DEFAULT_LOCAL_HOTKEYS, 'KeyF', false)).toBe('fullscreen')
  })
  it('finds conflicts', () => {
    expect(findConflict(DEFAULT_LOCAL_HOTKEYS, 'Space', false, 'like')).toBe('playPause')
    expect(findConflict(DEFAULT_LOCAL_HOTKEYS, 'Space', false, 'playPause')).toBeNull()
  })
  it('builds labels and Electron accelerators', () => {
    expect(comboParts('Mod+BracketRight', false)).toEqual(['Ctrl', ']'])
    expect(comboParts('Mod+KeyL', true)).toEqual(['⌘', 'L'])
    expect(toAccelerator('Mod+Alt+ArrowRight')).toBe('CommandOrControl+Alt+Right')
    expect(toAccelerator('Ctrl+Shift+KeyL')).toBe('Control+Shift+L')
    expect(toAccelerator('MediaTrackNext')).toBe('MediaNextTrack')
    expect(toAccelerator('IntlRo')).toBeNull()
  })
  it('only allows global shortcuts that will not swallow normal typing', () => {
    expect(globalAllowed('KeyL')).toBe(false)
    expect(globalAllowed('Alt+KeyL')).toBe(true)
    expect(globalAllowed('F9')).toBe(true)
    expect(globalAllowed('MediaPlayPause')).toBe(true)
  })
  it('merges stored maps with defaults', () => {
    const m = mergeHotkeys({ like: [], next: ['Alt+KeyN'], bogus: ['X'] }, DEFAULT_LOCAL_HOTKEYS)
    expect(m.like).toEqual([])
    expect(m.next).toEqual(['Alt+KeyN'])
    expect(m.playPause).toEqual(['Space'])
    expect('bogus' in m).toBe(false)
  })
})
