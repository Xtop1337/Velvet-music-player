import { useEffect } from 'react'
import { create } from 'zustand'
import type { UpdateStatus } from '@shared/types'
import { useSettings } from '@renderer/store/settings'

export const useUpdateStatus = create<{ status: UpdateStatus }>(() => ({ status: { state: 'idle' } }))

/** Configures the auto-updater from settings and mirrors its status. Mount once. */
export function useUpdates(): void {
  const auto = useSettings((s) => s.settings.updates.auto)
  const loaded = useSettings((s) => s.loaded)
  useEffect(() => {
    void window.velvet.updates.status().then((status) => useUpdateStatus.setState({ status }))
    return window.velvet.updates.onStatus((status) => useUpdateStatus.setState({ status }))
  }, [])
  useEffect(() => {
    if (loaded) void window.velvet.updates.configure(auto)
  }, [auto, loaded])
}
