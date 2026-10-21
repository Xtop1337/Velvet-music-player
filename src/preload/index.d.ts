import type { VelvetApi } from './index'

declare global {
  interface Window {
    velvet: VelvetApi
  }
}

export {}
