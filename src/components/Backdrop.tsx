import { streamUrl } from '@renderer/lib/media'
import { useSettings } from '@renderer/store/settings'

/**
 * The user's own background: a picture or a video.
 * The moving backgrounds (Aurora blobs, live cover with its dimming veil) are painted by `BackgroundCanvas`.
 */
export function Backdrop(): React.JSX.Element | null {
  const mode = useSettings((s) => s.settings.backgroundMode)
  const video = useSettings((s) => s.settings.backgroundVideo)
  if (mode === 'image') return <div className="user-bg" />
  if (mode === 'video' && video) {
    return (
      <div className="user-video">
        <video src={streamUrl(video)} autoPlay loop muted playsInline />
      </div>
    )
  }
  return null
}
