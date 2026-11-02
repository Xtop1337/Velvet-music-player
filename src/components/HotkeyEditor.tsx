import { AlertTriangle, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  comboFromEvent,
  comboParts,
  DEFAULT_GLOBAL_HOTKEYS,
  DEFAULT_LOCAL_HOTKEYS,
  findConflict,
  GLOBAL_ACTIONS,
  globalAllowed,
  LOCAL_ACTIONS,
  portableCombo,
  sameCombo,
  toAccelerator,
  type HotkeyMap
} from '@shared/hotkeys'
import { useGlobalHotkeyStatus } from '@renderer/hooks/useRemote'
import { isMac } from '@renderer/hooks/useShortcuts'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'
import { Button, Toggle } from './ui'

type Scope = 'local' | 'global'

function Keys({ combo }: { combo: string }): React.JSX.Element {
  return (
    <span className="kbd-combo">
      {comboParts(combo, isMac).map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  )
}

function HotkeyTable({ scope }: { scope: Scope }): React.JSX.Element {
  const { t } = useTranslation()
  const map = useSettings((s) => s.settings.hotkeys[scope]) as HotkeyMap<string>
  const setSection = useSettings((s) => s.setSection)
  const failed = useGlobalHotkeyStatus((s) => s.failed)
  const toast = useUi((s) => s.toast)
  const [recording, setRecording] = useState<string | null>(null)
  const actions: readonly string[] = scope === 'local' ? LOCAL_ACTIONS : GLOBAL_ACTIONS

  const save = (next: HotkeyMap<string>): void => {
    const hotkeys = useSettings.getState().settings.hotkeys
    setSection('hotkeys', { ...hotkeys, [scope]: next })
  }

  // while recording, the next key press becomes the new shortcut
  useEffect(() => {
    if (!recording) return
    document.body.dataset.recordingHotkey = '1'
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecording(null)
        return
      }
      const raw = comboFromEvent(e)
      if (!raw) return // just a modifier, keep waiting
      const combo = portableCombo(raw, isMac)
      if (scope === 'global' && (!toAccelerator(combo) || !globalAllowed(combo))) {
        toast(t('hotkeys.globalNeedsModifier'), 'error')
        setRecording(null)
        return
      }
      const current = useSettings.getState().settings.hotkeys[scope] as HotkeyMap<string>
      const next: HotkeyMap<string> = { ...current }
      const other = findConflict(current, combo, isMac, recording)
      if (other) {
        next[other] = current[other].filter((c) => !sameCombo(c, combo, isMac))
        toast(t('hotkeys.moved', { action: t(`hotkeys.actions.${other}`) }), 'info')
      }
      if (!next[recording].some((c) => sameCombo(c, combo, isMac))) next[recording] = [...next[recording], combo]
      save(next)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      delete document.body.dataset.recordingHotkey
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  return (
    <div className="hotkeys">
      {actions.map((action) => (
        <div key={action} className={`hotkey-row ${recording === action ? 'is-recording' : ''}`}>
          <span className="hotkey-row__label">{t(`hotkeys.actions.${action}`)}</span>
          <div className="hotkey-row__keys">
            {map[action].map((combo) => {
              const bad = scope === 'global' && failed.some((f) => sameCombo(f, combo, isMac))
              return (
                <span key={combo} className={`hotkey-chip ${bad ? 'is-bad' : ''}`} title={bad ? t('hotkeys.taken') : undefined}>
                  {bad && <AlertTriangle size={13} />}
                  <Keys combo={combo} />
                  <button
                    type="button"
                    className="hotkey-chip__remove"
                    aria-label={t('hotkeys.remove')}
                    title={t('hotkeys.remove')}
                    onClick={() => save({ ...map, [action]: map[action].filter((c) => c !== combo) })}
                  >
                    <X size={12} />
                  </button>
                </span>
              )
            })}
            {recording === action ? (
              <span className="hotkey-chip is-listening">{t('hotkeys.pressKeys')}</span>
            ) : (
              <button type="button" className="hotkey-add" onClick={() => setRecording(action)} aria-label={t('hotkeys.add')} title={t('hotkeys.add')}>
                <Plus size={14} />
                {map[action].length === 0 && <span>{t('hotkeys.add')}</span>}
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="hotkeys__foot">
        <Button
          variant="ghost"
          icon={<RotateCcw size={15} />}
          onClick={() => save(scope === 'local' ? { ...DEFAULT_LOCAL_HOTKEYS } : { ...DEFAULT_GLOBAL_HOTKEYS })}
        >
          {t('hotkeys.reset')}
        </Button>
      </div>
    </div>
  )
}

export function HotkeySettings(): React.JSX.Element {
  const { t } = useTranslation()
  const globalOn = useSettings((s) => s.settings.desktop.globalShortcuts)
  const setSection = useSettings((s) => s.setSection)
  return (
    <section className="card">
      <h2 className="card__title">{t('hotkeys.title')}</h2>
      <p className="muted small">{t('hotkeys.hint')}</p>
      <h4 className="label">{t('hotkeys.local')}</h4>
      <HotkeyTable scope="local" />
      <div className="setting-row">
        <div>
          <strong>{t('hotkeys.global')}</strong>
          <span>{t('hotkeys.globalHint')}</span>
        </div>
        <Toggle checked={globalOn} onChange={(v) => setSection('desktop', { globalShortcuts: v })} label={t('hotkeys.global')} />
      </div>
      {globalOn && <HotkeyTable scope="global" />}
    </section>
  )
}
