/**
 * Keyboard shortcuts.
 *
 * A combo is stored as modifiers + a physical key code, e.g. "Mod+ArrowRight" or "Alt+KeyL".
 * Physical codes (KeyboardEvent.code) keep shortcuts working on any keyboard layout:
 * on a Russian layout "F" types "а", but its code is still "KeyF".
 * "Mod" means Ctrl on Windows/Linux and Cmd on macOS.
 */

export const LOCAL_ACTIONS = [
  'playPause',
  'next',
  'prev',
  'seekForward',
  'seekBackward',
  'volumeUp',
  'volumeDown',
  'mute',
  'speedUp',
  'speedDown',
  'speedReset',
  'like',
  'shuffle',
  'repeat',
  'search',
  'visualizer',
  'fullscreen',
  'miniPlayer'
] as const

export const GLOBAL_ACTIONS = ['playPause', 'next', 'prev', 'volumeUp', 'volumeDown', 'like', 'showWindow', 'miniPlayer'] as const

export type LocalAction = (typeof LOCAL_ACTIONS)[number]
export type GlobalAction = (typeof GLOBAL_ACTIONS)[number]
export type HotkeyMap<A extends string> = Record<A, string[]>

export const DEFAULT_LOCAL_HOTKEYS: HotkeyMap<LocalAction> = {
  playPause: ['Space'],
  next: ['Mod+ArrowRight'],
  prev: ['Mod+ArrowLeft'],
  seekForward: ['ArrowRight'],
  seekBackward: ['ArrowLeft'],
  volumeUp: ['ArrowUp'],
  volumeDown: ['ArrowDown'],
  mute: ['KeyM'],
  speedUp: ['BracketRight'],
  speedDown: ['BracketLeft'],
  speedReset: ['Backslash'],
  like: ['KeyL'],
  shuffle: ['KeyS'],
  repeat: ['KeyR'],
  search: ['Mod+KeyF'],
  visualizer: ['KeyV'],
  fullscreen: ['KeyF'],
  miniPlayer: ['Mod+Shift+KeyM']
}

export const DEFAULT_GLOBAL_HOTKEYS: HotkeyMap<GlobalAction> = {
  playPause: ['Mod+Alt+Space'],
  next: ['Mod+Alt+ArrowRight'],
  prev: ['Mod+Alt+ArrowLeft'],
  volumeUp: ['Mod+Alt+ArrowUp'],
  volumeDown: ['Mod+Alt+ArrowDown'],
  like: [],
  showWindow: [],
  miniPlayer: []
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn'])
const ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']

export interface KeyLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Combo for a key event, with explicit modifiers ("Ctrl", "Meta"). Null for a lone modifier press. */
export function comboFromEvent(e: KeyLike): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  return [...mods, e.code].join('+')
}

/** Replaces "Mod" with the platform's main modifier and orders modifiers consistently. */
export function resolveCombo(combo: string, isMac: boolean): string {
  const parts = combo.split('+').filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : m)))
  return [...ORDER.filter((m) => mods.has(m)), key].join('+')
}

/** On save, an explicit Ctrl (Cmd on macOS) is stored as "Mod" so settings move between systems. */
export function portableCombo(combo: string, isMac: boolean): string {
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  const main = isMac ? 'Meta' : 'Ctrl'
  const mods = parts.map((m) => (m === main ? 'Mod' : m))
  return [...ORDER.filter((m) => mods.includes(m)), key].join('+')
}

export function sameCombo(a: string, b: string, isMac: boolean): boolean {
  return resolveCombo(a, isMac) === resolveCombo(b, isMac)
}

export function hasModifier(combo: string): boolean {
  return combo.includes('+')
}

const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  MediaPlayPause: '⏯',
  MediaTrackNext: '⏭',
  MediaTrackPrevious: '⏮',
  MediaStop: '⏹',
  AudioVolumeUp: 'Vol+',
  AudioVolumeDown: 'Vol−',
  AudioVolumeMute: 'Mute',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadEnter: 'Num Enter',
  NumpadDecimal: 'Num .'
}

export function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`
  return code
}

/** Human-readable parts of a combo, e.g. ["Ctrl", "→"]. */
export function comboParts(combo: string, isMac: boolean): string[] {
  const parts = resolveCombo(combo, isMac).split('+')
  const key = parts.pop() ?? ''
  const names: Record<string, string> = isMac ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' } : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' }
  return [...parts.map((m) => names[m] ?? m), keyLabel(key)]
}

const ACCEL_KEYS: Record<string, string> = {
  Space: 'Space',
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/** Accelerator string for a combo (Electron style), or null when the key can't be registered globally. */
export function toAccelerator(combo: string): string | null {
  const parts = combo.split('+')
  const code = parts.pop() ?? ''
  let key: string | undefined = ACCEL_KEYS[code]
  if (!key && /^Key[A-Z]$/.test(code)) key = code.slice(3)
  if (!key && /^Digit\d$/.test(code)) key = code.slice(5)
  if (!key && /^Numpad\d$/.test(code)) key = `num${code.slice(6)}`
  if (!key && /^F([1-9]|1\d|2[0-4])$/.test(code)) key = code
  if (!key) return null
  const mods = parts.map((m) => ({ Mod: 'CommandOrControl', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' })[m] ?? m)
  return [...mods, key].join('+')
}

/** A global shortcut without a modifier would swallow that key in every app. */
export function globalAllowed(combo: string): boolean {
  const code = combo.split('+').pop() ?? ''
  return hasModifier(combo) || /^F([1-9]|1\d|2[0-4])$/.test(code) || /^(Media|AudioVolume)/.test(code)
}

/** Fills missing actions with defaults and drops unknown ones. */
export function mergeHotkeys<A extends string>(stored: Partial<Record<string, string[]>> | undefined, defaults: HotkeyMap<A>): HotkeyMap<A> {
  const out = {} as HotkeyMap<A>
  for (const a of Object.keys(defaults) as A[]) {
    const v = stored?.[a]
    out[a] = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && c) : [...defaults[a]]
  }
  return out
}

/** The action already bound to `combo` (other than `except`), if any. */
export function findConflict<A extends string>(map: HotkeyMap<A>, combo: string, isMac: boolean, except?: A): A | null {
  for (const a of Object.keys(map) as A[]) {
    if (a !== except && map[a].some((c) => sameCombo(c, combo, isMac))) return a
  }
  return null
}

export function actionFor<A extends string>(map: HotkeyMap<A>, combo: string, isMac: boolean): A | null {
  return findConflict(map, combo, isMac)
}
