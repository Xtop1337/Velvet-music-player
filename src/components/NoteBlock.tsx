import { StickyNote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUi } from '@renderer/store/ui'

/** A note under a playlist's title: the text (click to edit) or "Add a note". */
export function NoteBlock({ note, title, onSave }: { note?: string; title: string; onSave: (v: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const edit = (): void =>
    useUi.getState().askText({ title, value: note ?? '', placeholder: t('notes.placeholder'), multiline: true, onSubmit: onSave })
  return note ? (
    <button type="button" className="note-block no-drag" title={t('notes.edit')} onClick={edit}>
      <StickyNote size={14} />
      <span>{note}</span>
    </button>
  ) : (
    <button type="button" className="link-btn note-add no-drag" onClick={edit}>
      <StickyNote size={14} /> {t('notes.add')}
    </button>
  )
}
