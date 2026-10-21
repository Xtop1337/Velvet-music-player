import { Download, RefreshCw, Rocket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUpdateStatus } from '@renderer/hooks/useUpdates'
import { useSettings } from '@renderer/store/settings'
import { Button, Toggle } from './ui'

/** Sidebar banner shown when an update has been downloaded. */
export function UpdateBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useUpdateStatus((s) => s.status)
  if (status.state !== 'ready') return null
  return (
    <button type="button" className="update-banner" onClick={() => void window.velvet.updates.install()}>
      <Rocket size={16} />
      <span>
        <strong>{t('updates.ready', { version: status.version })}</strong>
        <small>{t('updates.restart')}</small>
      </span>
    </button>
  )
}

export function UpdateSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useUpdateStatus((s) => s.status)
  const auto = useSettings((s) => s.settings.updates.auto)
  const setSection = useSettings((s) => s.setSection)
  const busy = status.state === 'checking' || status.state === 'downloading'
  const text =
    status.state === 'downloading'
      ? t('updates.downloading', { version: status.version, percent: Math.round((status.percent ?? 0) * 100) })
      : status.state === 'ready'
        ? t('updates.ready', { version: status.version })
        : status.state === 'error'
          ? t('updates.error', { error: status.error ?? '' })
          : t(`updates.states.${status.state}`)
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>{t('updates.auto')}</strong>
          <span>{text}</span>
        </div>
        <div className="setting-row__control">
          {status.state === 'ready' ? (
            <Button variant="primary" icon={<Download size={16} />} onClick={() => void window.velvet.updates.install()}>
              {t('updates.install')}
            </Button>
          ) : (
            <Button
              icon={<RefreshCw size={16} className={busy ? 'spin' : ''} />}
              disabled={busy || status.state === 'dev' || status.state === 'unconfigured'}
              onClick={() => void window.velvet.updates.check()}
            >
              {t('updates.check')}
            </Button>
          )}
          <Toggle checked={auto} onChange={(v) => setSection('updates', { auto: v })} label={t('updates.auto')} />
        </div>
      </div>
    </>
  )
}
