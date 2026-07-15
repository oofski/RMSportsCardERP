import { safeStorage } from 'electron'
import type { RememberedCredentials } from '@shared/types'
import { getDb, getMeta, setMeta } from '../db/database'

const KEY = 'remembered_credentials'

/**
 * "Remember me" credential storage. Encrypted at rest with the OS keychain via
 * Electron's safeStorage when available (Windows DPAPI / macOS Keychain). If
 * encryption isn't available on the platform, falls back to base64 so the
 * feature still works — a reasonable trade-off for a convenience feature on the
 * employee's own device.
 */
function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setRemembered(creds: RememberedCredentials): void {
  const json = JSON.stringify(creds)
  const stored = encAvailable()
    ? 'v1:' + safeStorage.encryptString(json).toString('base64')
    : 'b64:' + Buffer.from(json, 'utf8').toString('base64')
  setMeta(getDb(), KEY, stored)
}

export function getRemembered(): RememberedCredentials | null {
  const raw = getMeta(getDb(), KEY)
  if (!raw) return null
  try {
    let json: string
    if (raw.startsWith('v1:')) {
      if (!encAvailable()) return null
      json = safeStorage.decryptString(Buffer.from(raw.slice(3), 'base64'))
    } else if (raw.startsWith('b64:')) {
      json = Buffer.from(raw.slice(4), 'base64').toString('utf8')
    } else {
      return null
    }
    const parsed = JSON.parse(json) as RememberedCredentials
    if (typeof parsed.identifier === 'string' && typeof parsed.password === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function clearRemembered(): void {
  setMeta(getDb(), KEY, '')
}
