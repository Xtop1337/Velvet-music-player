import type { VelvetApi } from './bridge'

declare global {
  interface Window {
    velvet: VelvetApi
  }
}

export {}
