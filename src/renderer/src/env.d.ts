/// <reference types="vite/client" />
import type { RmOpsApi } from '../../preload/index'

declare global {
  interface Window {
    rmops: RmOpsApi
  }
}

export {}
