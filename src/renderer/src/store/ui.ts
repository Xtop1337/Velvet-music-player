import type { ReactNode } from 'react'
import { create } from 'zustand'

export type View =
  | { type: 'library' }
  | { type: 'playlist'; id: string }
  | { type: 'import' }
  | { type: 'settings' }
  | { type: 'liked' }
  | { type: 'stats' }
  | { type: 'search' }
  | { type: 'album'; album: string; artist: string }
  | { type: 'artist'; artist: string }

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

export interface MenuItem {
  label?: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  onClick?: () => void
  children?: MenuItem[]
}

interface UiState {
  view: View
  search: string
  nowPlayingOpen: boolean
  queueOpen: boolean
  speedOpen: boolean
  tagEditorId: string | null
  exportId: string | null
  toasts: Toast[]
  menu: { x: number; y: number; items: MenuItem[] } | null
  prompt: { title: string; value: string; placeholder?: string; onSubmit: (v: string) => void } | null
  confirm: { title: string; text?: string; danger?: boolean; onConfirm: () => void } | null
  navigate: (view: View) => void
  setSearch: (s: string) => void
  setNowPlaying: (open: boolean) => void
  setQueue: (open: boolean) => void
  setSpeed: (open: boolean) => void
  editTags: (id: string | null) => void
  openExport: (id: string | null) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  openMenu: (x: number, y: number, items: MenuItem[]) => void
  closeMenu: () => void
  askText: (p: UiState['prompt']) => void
  askConfirm: (p: UiState['confirm']) => void
}

let toastId = 0

export const useUi = create<UiState>((set, get) => ({
  view: { type: 'library' },
  search: '',
  nowPlayingOpen: false,
  queueOpen: false,
  speedOpen: false,
  tagEditorId: null,
  exportId: null,
  toasts: [],
  menu: null,
  prompt: null,
  confirm: null,
  navigate: (view) => set({ view, nowPlayingOpen: false }),
  setSearch: (search) => set({ search }),
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),
  setQueue: (queueOpen) => set({ queueOpen }),
  setSpeed: (speedOpen) => set({ speedOpen }),
  editTags: (tagEditorId) => set({ tagEditorId }),
  openExport: (exportId) => set({ exportId, speedOpen: false }),
  toast: (text, kind = 'info') => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, text, kind }].slice(-4) })
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3200)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  askText: (prompt) => set({ prompt }),
  askConfirm: (confirm) => set({ confirm })
}))
