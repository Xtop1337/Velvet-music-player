import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SmartField, SmartOp, SmartPlaylist, SmartRule } from '@shared/types'
import { defaultRule, evaluateSmart, FIELDS, kindOf, opsFor, smartTemplate, type TemplateId } from '@renderer/lib/smart'
import { useLibrary } from '@renderer/store/library'
import { useStats } from '@renderer/store/stats'
import { useUi } from '@renderer/store/ui'
import { Button, Field, Modal } from './ui'

const TEMPLATES: TemplateId[] = ['oftenNotLiked', 'addedWeek', 'forgottenLoved', 'fast', 'calm', 'decade']
const SORTS: SmartPlaylist['sort']['key'][] = ['added', 'plays', 'lastPlayed', 'title', 'artist', 'bpm', 'random']

function RuleRow({ rule, onChange, onRemove }: { rule: SmartRule; onChange: (r: SmartRule) => void; onRemove: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const kind = kindOf(rule.field)
  return (
    <div className="rule-row">
      <select className="input input--select input--sm" aria-label={t('smart.field')} value={rule.field} onChange={(e) => onChange(defaultRule(e.target.value as SmartField))}>
        {FIELDS.map((f) => (
          <option key={f.field} value={f.field}>
            {t(`smart.fields.${f.field}`)}
          </option>
        ))}
      </select>
      {kind === 'bool' ? (
        <>
          <select className="input input--select input--sm" aria-label={t('smart.value')} value={rule.op === 'isNot' ? 'false' : rule.value} onChange={(e) => onChange({ ...rule, op: 'is', value: e.target.value })}>
            <option value="true">{t('smart.yes')}</option>
            <option value="false">{t('smart.no')}</option>
          </select>
          {/* keeps the columns aligned with the other rules */}
          <span />
          <span />
        </>
      ) : (
        <>
          <select className="input input--select input--sm" aria-label={t('smart.op')} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as SmartOp })}>
            {opsFor(kind).map((op) => (
              <option key={op} value={op}>
                {t(kind === 'days' ? `smart.daysOps.${op}` : `smart.ops.${op}`)}
              </option>
            ))}
          </select>
          <input
            className="input input--sm"
            aria-label={t('smart.value')}
            inputMode={kind === 'text' ? 'text' : 'decimal'}
            value={rule.value}
            placeholder={t(`smart.placeholders.${rule.field}`, { defaultValue: '' })}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          />
          <span className="rule-row__unit">{kind === 'days' ? t('smart.days') : ''}</span>
        </>
      )}
      <button type="button" className="icon-btn icon-btn--sm" aria-label={t('smart.removeRule')} title={t('smart.removeRule')} onClick={onRemove}>
        <Trash2 size={15} />
      </button>
    </div>
  )
}

/** Create / edit a smart playlist: rules, match all / any, order, limit; shows how many tracks fit. */
export function SmartPlaylistDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const editing = useUi((s) => s.smartEdit)
  const close = (): void => useUi.getState().editSmart(null)
  const [pl, setPl] = useState<SmartPlaylist | null>(null)
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const history = useStats((s) => s.history)
  const isNew = !!editing && !useLibrary.getState().smartPlaylists.some((p) => p.id === editing.id)

  useEffect(() => setPl(editing ? structuredClone(editing) : null), [editing])
  const count = useMemo(() => (pl ? evaluateSmart(pl, tracks, history, order).length : 0), [pl, tracks, history, order])
  if (!editing || !pl) return null

  const setRule = (i: number, r: SmartRule): void => setPl({ ...pl, rules: pl.rules.map((x, k) => (k === i ? r : x)) })
  const save = (): void => {
    const name = pl.name.trim() || t('smart.untitled')
    useLibrary.getState().saveSmart({ ...pl, name, limit: Math.max(0, Math.floor(Number(pl.limit) || 0)) })
    close()
    useUi.getState().navigate({ type: 'smart', id: pl.id })
  }

  return (
    <Modal
      title={isNew ? t('smart.new') : t('smart.edit')}
      onClose={close}
      width={640}
      footer={
        <>
          <span className="muted small modal__count">{t('smart.matches', { count })}</span>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="smart-editor">
        {isNew && (
          <div className="chips">
            {TEMPLATES.map((id) => (
              <button key={id} type="button" className="chip" onClick={() => setPl({ ...smartTemplate(id, t(`smart.templates.${id}`)), id: pl.id })}>
                {t(`smart.templates.${id}`)}
              </button>
            ))}
          </div>
        )}
        <Field label={t('smart.name')}>
          <input className="input" autoFocus value={pl.name} placeholder={t('smart.untitled')} onChange={(e) => setPl({ ...pl, name: e.target.value })} />
        </Field>
        <div className="smart-editor__match">
          <span>{t('smart.matchLabel')}</span>
          <select className="input input--select input--sm" value={pl.match} onChange={(e) => setPl({ ...pl, match: e.target.value as 'all' | 'any' })}>
            <option value="all">{t('smart.matchAll')}</option>
            <option value="any">{t('smart.matchAny')}</option>
          </select>
        </div>
        <div className="smart-editor__rules">
          {pl.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(x) => setRule(i, x)} onRemove={() => setPl({ ...pl, rules: pl.rules.filter((_, k) => k !== i) })} />
          ))}
          <button type="button" className="link-btn" onClick={() => setPl({ ...pl, rules: [...pl.rules, defaultRule()] })}>
            <Plus size={15} /> {t('smart.addRule')}
          </button>
        </div>
        <div className="smart-editor__order">
          <Field label={t('smart.sort')}>
            <select className="input input--select" value={pl.sort.key} onChange={(e) => setPl({ ...pl, sort: { ...pl.sort, key: e.target.value as SmartPlaylist['sort']['key'] } })}>
              {SORTS.map((k) => (
                <option key={k} value={k}>
                  {t(`smart.sorts.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          {pl.sort.key !== 'random' && (
            <Field label={t('smart.direction')}>
              <select className="input input--select" value={pl.sort.desc ? 'desc' : 'asc'} onChange={(e) => setPl({ ...pl, sort: { ...pl.sort, desc: e.target.value === 'desc' } })}>
                <option value="desc">{t('smart.desc')}</option>
                <option value="asc">{t('smart.asc')}</option>
              </select>
            </Field>
          )}
          <Field label={t('smart.limit')} hint={t('smart.limitHint')}>
            <input className="input" inputMode="numeric" value={pl.limit || ''} placeholder="∞" onChange={(e) => setPl({ ...pl, limit: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/** A new smart playlist to start editing from. */
export function newSmart(): SmartPlaylist {
  return { ...smartTemplate('oftenNotLiked', ''), rules: [defaultRule()] }
}
