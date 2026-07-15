import type { RmOpsApi } from './index'

declare global {
  interface Window {
    rmops: RmOpsApi
  }
}

export {}
