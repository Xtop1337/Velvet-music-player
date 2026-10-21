import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
const { pickLrclib } = await import('../src/main/services/lyrics')

describe('pickLrclib', () => {
  it('prefers synced lyrics with the closest duration', () => {
    const best = pickLrclib(
      [
        { plainLyrics: 'a', duration: 200 },
        { syncedLyrics: '[00:01]x', duration: 260 },
        { syncedLyrics: '[00:01]y', duration: 201 }
      ],
      200
    )
    expect(best?.syncedLyrics).toBe('[00:01]y')
  })
  it('returns null when nothing usable', () => {
    expect(pickLrclib([{ plainLyrics: null, syncedLyrics: null }], 100)).toBeNull()
  })
})
