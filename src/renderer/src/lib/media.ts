/** URL for a local file served by the main process (supports seeking). */
export function mediaUrl(path: string | undefined): string {
  return path ? `velvet://file/${encodeURIComponent(path)}` : ''
}
