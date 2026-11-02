import { useEffect, useRef, useState, type RefObject } from 'react'

interface Options {
  /** the element is on screen (listeners attach while true) */
  active: boolean
  /** something attached to the element is open (e.g. the speed panel): stay visible */
  hold?: boolean
  /** shown this long when it appears, so you see where it is */
  initialMs?: number
  /** hidden this long after the pointer leaves */
  hideDelayMs?: number
}

/**
 * Visible while the pointer is over the element (or a button is held down in it, or it has
 * keyboard focus, or `hold` is set); fades away shortly after. Returns whether it should show.
 */
export function useAutoHide(ref: RefObject<HTMLElement | null>, { active, hold = false, initialMs = 2500, hideDelayMs = 900 }: Options): boolean {
  const [visible, setVisible] = useState(true)
  const st = useRef({ hover: false, pressed: false, focus: false, hold, timer: 0 })
  st.current.hold = hold

  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const s = st.current
    const busy = (): boolean => s.hover || s.pressed || s.focus || s.hold
    const show = (): void => {
      window.clearTimeout(s.timer)
      setVisible(true)
    }
    const later = (ms: number): void => {
      window.clearTimeout(s.timer)
      s.timer = window.setTimeout(() => !busy() && setVisible(false), ms)
    }
    const enter = (): void => {
      s.hover = true
      show()
    }
    const leave = (): void => {
      s.hover = false
      if (!busy()) later(hideDelayMs)
    }
    const down = (): void => {
      s.pressed = true
    }
    const up = (): void => {
      if (!s.pressed) return
      s.pressed = false
      if (!busy()) later(hideDelayMs)
    }
    // only keyboard focus keeps it open: a clicked button keeps focus after the mouse has left
    const focusIn = (e: FocusEvent): void => {
      if ((e.target as Element).matches?.(':focus-visible')) {
        s.focus = true
        show()
      }
    }
    const focusOut = (e: FocusEvent): void => {
      if (el.contains(e.relatedTarget as Node)) return
      s.focus = false
      if (!busy()) later(hideDelayMs)
    }
    s.hover = el.matches(':hover')
    show()
    if (!busy()) later(initialMs)
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    return () => {
      window.clearTimeout(s.timer)
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
    }
  }, [active, ref, initialMs, hideDelayMs])

  // something opened from it (or closed again)
  useEffect(() => {
    if (!active) return
    const s = st.current
    if (hold) {
      window.clearTimeout(s.timer)
      setVisible(true)
    } else if (!(s.hover || s.pressed || s.focus)) {
      window.clearTimeout(s.timer)
      s.timer = window.setTimeout(() => setVisible(false), hideDelayMs)
    }
  }, [hold, active, hideDelayMs])

  return active ? visible : true
}
