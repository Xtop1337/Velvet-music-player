import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Minimize / maximize / close in the Windows style. The window is frameless, and these take the
 * place of the system caption buttons drawn over the page before (same size, same spot).
 */
export function WindowControls(): React.JSX.Element {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const check = (): void => void window.velvet.window.isMaximized().then(setMaximized)
    check()
    return window.velvet.window.onResized(check)
  }, [])

  return (
    <div className="window-controls" role="group" aria-label="Window">
      <button type="button" aria-label={t('window.minimize')} title={t('window.minimize')} onClick={() => void window.velvet.window.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
        title={maximized ? t('window.restore') : t('window.maximize')}
        onClick={() => void window.velvet.window.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button type="button" className="window-controls__close" aria-label={t('window.close')} title={t('window.close')} onClick={() => void window.velvet.window.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}
