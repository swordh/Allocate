'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'

interface SupportContextValue {
  helpOpen: boolean
  openHelp: () => void
  closeHelp: () => void
  notificationsOpen: boolean
  openNotifications: () => void
  closeNotifications: () => void
  unreadCount: number
}

const SupportContext = createContext<SupportContextValue | null>(null)

export function SupportProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [helpOpen, setHelpOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const unreadCount = 0 // placeholder for future notification system

  const openHelp = useCallback(() => {
    setHelpOpen(true)
    setNotificationsOpen(false)
  }, [])

  const closeHelp = useCallback(() => setHelpOpen(false), [])

  const openNotifications = useCallback(() => {
    setNotificationsOpen(true)
    setHelpOpen(false)
  }, [])

  const closeNotifications = useCallback(() => setNotificationsOpen(false), [])

  // Global keyboard shortcut: Shift+? opens the help modal. Guarded against
  // typing in any editable field — otherwise a bug report whose text happens
  // to end in "?" would reopen the modal on itself. Escape is NOT handled
  // here: SupportModal and NotificationsPanel each own their own Escape now,
  // so closing one never blows away the other mid-transition.
  useEffect(() => {
    if (!user) return
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === '?' || e.key === '/') && !helpOpen) {
        const target = e.target as HTMLElement | null
        const editable =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target?.isContentEditable
        if (editable) return
        e.preventDefault()
        openHelp()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [user, helpOpen, openHelp])

  return (
    <SupportContext.Provider value={{
      helpOpen, openHelp, closeHelp,
      notificationsOpen, openNotifications, closeNotifications,
      unreadCount,
    }}>
      {children}
    </SupportContext.Provider>
  )
}

export function useSupportContext() {
  const ctx = useContext(SupportContext)
  if (!ctx) throw new Error('useSupportContext must be used inside SupportProvider')
  return ctx
}
