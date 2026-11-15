import { invoke } from '@tauri-apps/api/core'

/**
 * Lines for velvet.log (in the app's log folder): playback errors and audio diagnostics, so a
 * problem on someone's computer can be understood from the log. Repeated lines are dropped.
 */
let sent = 0
let last = ''
export function logUi(level: 'info' | 'warn' | 'error', message: string): void {
  if (message === last || sent > 300) return
  last = message
  sent++
  void invoke('ui_log', { level, message }).catch(() => {})
}

/** Uncaught errors of the page go to the log too. */
export function captureErrors(): void {
  window.addEventListener('error', (e) => logUi('error', `page error: ${e.message} @ ${e.filename?.split('/').pop() ?? ''}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; name?: string } | undefined
    if (r?.name === 'AbortError') return
    logUi('error', `unhandled rejection: ${r?.message ?? String(e.reason)}`.slice(0, 600))
  })
}
