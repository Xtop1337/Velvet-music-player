import { ExternalLink, RefreshCw, Rocket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUpdateStatus } from '@renderer/hooks/useUpdates'
import { useSettings } from '@renderer/store/settings'
import { Button, Modal, Toggle } from './ui'

const openRelease = (): void => void window.velvet.updates.open().catch(() => {})

/** Versions the user postponed with "Later": asked again on the next launch, not every 6 hours. */
const postponed = new Set<string>()

/** "A new version is out — would you like to update?" Update opens the release on GitHub. */
export function UpdateDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useUpdateStatus((s) => s.status)
  const [, rerender] = useState(0)
  if (status.state !== 'available' || !status.version || postponed.has(status.version)) return null
  const later = (): void => {
    postponed.add(status.version!)
    rerender((n) => n + 1)
  }
  return (
    <Modal
      title={t('updates.dialogTitle')}
      onClose={later}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={later}>
            {t('updates.later')}
          </Button>
          <Button
            variant="primary"
            icon={<ExternalLink size={16} />}
            onClick={() => {
              openRelease()
              later()
            }}
          >
            {t('updates.update')}
          </Button>
        </>
      }
    >
      <div className="update-dialog">
        <Rocket size={28} className="update-dialog__icon" />
        <p>{t('updates.dialogText', { version: status.version, current: status.current ?? '' })}</p>
      </div>
      {status.notes && (
        <div className="update-notes">
          <strong>{t('updates.whatsNew')}</strong>
          <p>{status.notes}</p>
        </div>
      )}
    </Modal>
  )
}

/** Sidebar banner while a newer version is available. */
export function UpdateBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useUpdateStatus((s) => s.status)
  if (status.state !== 'available') return null
  return (
    <button type="button" className="update-banner" onClick={openRelease}>
      <Rocket size={16} />
      <span>
        <strong>{t('updates.available', { version: status.version })}</strong>
        <small>{t('updates.openGithub')}</small>
      </span>
    </button>
  )
}

export function UpdateSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useUpdateStatus((s) => s.status)
  const auto = useSettings((s) => s.settings.updates.auto)
  const setSection = useSettings((s) => s.setSection)
  const busy = status.state === 'checking'
  const text =
    status.state === 'available'
      ? t('updates.available', { version: status.version })
      : status.state === 'error'
        ? t('updates.error', { error: status.error ?? '' })
        : t(`updates.states.${status.state}`)
  return (
    <div className="setting-row">
      <div>
        <strong>{t('updates.auto')}</strong>
        <span>{text}</span>
      </div>
      <div className="setting-row__control">
        {status.state === 'available' ? (
          <Button variant="primary" icon={<ExternalLink size={16} />} onClick={openRelease}>
            {t('updates.update')}
          </Button>
        ) : (
          <Button icon={<RefreshCw size={16} className={busy ? 'spin' : ''} />} disabled={busy} onClick={() => void window.velvet.updates.check()}>
            {t('updates.check')}
          </Button>
        )}
        <Toggle checked={auto} onChange={(v) => setSection('updates', { auto: v })} label={t('updates.auto')} />
      </div>
    </div>
  )
}
