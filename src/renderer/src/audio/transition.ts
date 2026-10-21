export type TransitionPlan = { action: 'none' } | { action: 'preload' } | { action: 'start'; seconds: number }

/**
 * Decides what to do with the next track while the current one plays.
 * All times are wall-clock seconds (already divided by the playback rate).
 */
export function planTransition(opts: {
  remaining: number
  /** wall-clock length of the current track */
  length: number
  crossfade: number
  gapless: boolean
}): TransitionPlan {
  const { remaining, length, crossfade, gapless } = opts
  if (!Number.isFinite(remaining) || length <= 0) return { action: 'none' }
  if (crossfade <= 0 && !gapless) return { action: 'none' }
  // never let the overlap eat more than half of a short track
  const fade = crossfade > 0 ? Math.min(crossfade, length / 2) : 0
  const startAt = fade > 0 ? fade : 0.06
  if (remaining <= startAt) return { action: 'start', seconds: fade > 0 ? fade : 0.03 }
  if (remaining <= startAt + 12) return { action: 'preload' }
  return { action: 'none' }
}
