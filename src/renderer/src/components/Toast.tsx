import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'

type ToastKind = 'info' | 'success' | 'error'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const ICONS: Record<ToastKind, string> = {
  info: 'Info',
  success: 'CheckCircle2',
  error: 'AlertCircle'
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++counter.current
      setItems((prev) => [...prev, { id, kind, message }])
      window.setTimeout(() => remove(id), 4200)
    },
    [remove]
  )

  const api: ToastApi = {
    toast,
    success: (m) => toast(m, 'success'),
    error: (m) => toast(m, 'error')
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => remove(t.id)}>
            <span className="t-ico">
              <Icon name={ICONS[t.kind]} size={17} />
            </span>
            <span className="t-body">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
