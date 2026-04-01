'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'

export type ToastType = 'saving' | 'success' | 'error'

export interface Toast {
  id: number
  type: ToastType
  message: string
}

interface ToastContextValue {
  toasts: Toast[]
  showToast: (type: ToastType, message: string, autoDismissMs?: number) => number
  dismissToast: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (type: ToastType, message: string, autoDismissMs?: number): number => {
      const id = ++counter.current
      setToasts((prev) => [...prev, { id, type, message }])
      if (autoDismissMs) {
        setTimeout(() => dismissToast(id), autoDismissMs)
      }
      return id
    },
    [dismissToast],
  )

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
