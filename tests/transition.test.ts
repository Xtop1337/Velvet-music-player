import { describe, expect, it } from 'vitest'
import { planTransition } from '../src/renderer/src/audio/transition'

describe('planTransition', () => {
  it('does nothing when crossfade and gapless are off (the default)', () => {
    expect(planTransition({ remaining: 0.01, length: 200, crossfade: 0, gapless: false })).toEqual({ action: 'none' })
  })
  it('preloads, then starts the crossfade at the right moment', () => {
    expect(planTransition({ remaining: 60, length: 200, crossfade: 6, gapless: false }).action).toBe('none')
    expect(planTransition({ remaining: 15, length: 200, crossfade: 6, gapless: false }).action).toBe('preload')
    expect(planTransition({ remaining: 5.9, length: 200, crossfade: 6, gapless: false })).toEqual({ action: 'start', seconds: 6 })
  })
  it('limits the overlap to half of a short track', () => {
    expect(planTransition({ remaining: 3, length: 8, crossfade: 10, gapless: false })).toEqual({ action: 'start', seconds: 4 })
  })
  it('gapless starts the next track a few ms before the end', () => {
    expect(planTransition({ remaining: 0.5, length: 200, crossfade: 0, gapless: true }).action).toBe('preload')
    expect(planTransition({ remaining: 0.05, length: 200, crossfade: 0, gapless: true })).toEqual({ action: 'start', seconds: 0.03 })
  })
})
