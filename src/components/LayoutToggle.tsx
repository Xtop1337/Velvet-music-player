import { LayoutGrid, List } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export type Layout = 'list' | 'grid'

/** The list / tiles choice of a page, remembered per page. */
export function useLayout(page: string): [Layout, (l: Layout) => void] {
  const key = `velvet.layout.${page}`
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(key) === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })
  const change = (l: Layout): void => {
    setLayout(l)
    try {
      localStorage.setItem(key, l)
    } catch {
      // a convenience only
    }
  }
  return [layout, change]
}

/** Two buttons: rows or tiles. */
export function LayoutToggle({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="layout-toggle" role="radiogroup" aria-label={t('layout.label')}>
      {(['list', 'grid'] as const).map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={value === l}
          className={value === l ? 'is-active' : ''}
          title={t(`layout.${l}`)}
          aria-label={t(`layout.${l}`)}
          onClick={() => onChange(l)}
        >
          {l === 'list' ? <List size={16} /> : <LayoutGrid size={16} />}
        </button>
      ))}
    </div>
  )
}
