import { Check, ChevronRight, CircleAlert, CircleCheck, Info } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUi, type MenuItem } from '@renderer/store/ui'
import { Button, Modal } from './ui'

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [open, setOpen] = useState<number | null>(null)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth - 8 ? Math.max(8, x - r.width) : x
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  return (
    <>
      <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu__sep" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`menu__item ${item.danger ? 'is-danger' : ''} ${open === i ? 'is-open' : ''}`}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (item.children) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right + 4, y: r.top - 6 })
                  setOpen(i)
                } else setOpen(null)
              }}
              onClick={(e) => {
                if (item.children) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right + 4, y: r.top - 6 })
                  setOpen(i)
                  return
                }
                item.onClick?.()
                onDone()
              }}
            >
              <span className="menu__icon">{item.checked ? <Check size={16} /> : item.icon}</span>
              <span className="menu__label">{item.label}</span>
              {item.children && <ChevronRight size={15} className="menu__chev" />}
            </button>
          )
        )}
      </div>
      {open !== null && items[open]?.children && (
        <MenuList key={open} items={items[open].children!} x={subPos.x} y={subPos.y} onDone={onDone} />
      )}
    </>
  )
}

export function ContextMenu(): React.JSX.Element | null {
  const menu = useUi((s) => s.menu)
  const close = useUi((s) => s.closeMenu)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.menu')) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])
  if (!menu) return null
  return (
    <div className="menu-layer">
      <MenuList items={menu.items} x={menu.x} y={menu.y} onDone={close} />
    </div>
  )
}

export function Toasts(): React.JSX.Element {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === 'success' ? <CircleCheck size={18} /> : t.kind === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  )
}

export function PromptDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const prompt = useUi((s) => s.prompt)
  const askText = useUi((s) => s.askText)
  const [value, setValue] = useState('')
  useEffect(() => setValue(prompt?.value ?? ''), [prompt])
  if (!prompt) return null
  const submit = (): void => {
    prompt.onSubmit(value)
    askText(null)
  }
  return (
    <Modal
      title={prompt.title}
      onClose={() => askText(null)}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => askText(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input className="input" autoFocus value={value} placeholder={prompt.placeholder} onChange={(e) => setValue(e.target.value)} />
      </form>
    </Modal>
  )
}

export function ConfirmDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const confirm = useUi((s) => s.confirm)
  const askConfirm = useUi((s) => s.askConfirm)
  if (!confirm) return null
  return (
    <Modal
      title={confirm.title}
      onClose={() => askConfirm(null)}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => askConfirm(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={confirm.danger ? 'danger' : 'primary'}
            onClick={() => {
              confirm.onConfirm()
              askConfirm(null)
            }}
          >
            {confirm.danger ? t('common.delete') : t('common.ok')}
          </Button>
        </>
      }
    >
      {confirm.text && <p className="muted">{confirm.text}</p>}
    </Modal>
  )
}
