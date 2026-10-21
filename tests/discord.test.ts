import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { buildActivity } = await import('../src/main/services/discord')

const base = {
  trackId: 't',
  title: 'Midnight Drive',
  artist: 'Neon Coast',
  album: 'Afterglow',
  coverUrl: 'https://i1.sndcdn.com/artworks-x-t500x500.jpg',
  sourceUrl: 'https://soundcloud.com/neon/midnight-drive',
  duration: 200,
  position: 50,
  rate: 1,
  playing: true,
  language: 'ru' as const
}

describe('buildActivity', () => {
  it('shows a Spotify-like "Listening" activity with cover, title and artist', () => {
    const a = buildActivity(base, { showSpeed: true, showButtons: true }, 1_000_000)
    expect(a.type).toBe(2)
    expect(a.details).toBe('Midnight Drive')
    expect(a.state).toBe('Neon Coast')
    expect(a.largeImageKey).toBe(base.coverUrl)
    expect(a.largeImageText).toBe('Afterglow')
    expect(a.startTimestamp).toBe(1_000_000 - 50_000)
    expect(a.endTimestamp).toBe(1_000_000 + 150_000)
    expect(a.buttons?.[0]).toEqual({ label: 'Открыть в SoundCloud', url: base.sourceUrl })
  })

  it('scales the progress bar by playback rate and shows the speed', () => {
    const a = buildActivity({ ...base, rate: 0.8 }, { showSpeed: true, showButtons: false }, 0)
    // 200 s at 0.8x lasts 250 s of wall-clock time
    expect((a.endTimestamp as number) - (a.startTimestamp as number)).toBe(250_000)
    expect(a.largeImageText).toBe('Afterglow · 0.8x')
    expect(a.buttons).toBeUndefined()
  })

  it('falls back to the logo for local covers and drops timestamps when paused', () => {
    const a = buildActivity({ ...base, coverUrl: undefined, playing: false, language: 'en' }, { showSpeed: false, showButtons: true }, 0)
    expect(a.largeImageKey).toBe('logo')
    expect(a.state).toBe('Paused · Neon Coast')
    expect(a.startTimestamp).toBeUndefined()
  })
})
