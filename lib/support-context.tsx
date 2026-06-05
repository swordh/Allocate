'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import { initActionTracker } from '@/lib/action-tracker'

export type SupportTab = 'bug' | 'feature' | 'help'

interface SupportContextValue {
  helpOpen: boolean
  activeTab: SupportTab
  openHelp: (tab?: SupportTab) => void
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
  const [activeTab, setActiveTab] = useState<SupportTab>('bug')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const unreadCount = 0 // placeholder for future notification system

  useEffect(() => { initActionTracker() }, [])

  const openHelp = useCallback((tab: SupportTab = 'bug') => {
    setActiveTab(tab)
    setHelpOpen(true)
    setNotificationsOpen(false)
  }, [])

  const closeHelp = useCallback(() => setHelpOpen(false), [])

  const openNotifications = useCallback(() => {
    setNotificationsOpen(true)
    setHelpOpen(false)
  }, [])

  const closeNotifications = useCallback(() => setNotificationsOpen(false), [])

  // Global keyboard shortcut: Shift+? opens help modal
  useEffect(() => {
    if (!user) return
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === '?' || e.key === '/') && !helpOpen) {
        e.preventDefault()
        openHelp()
      }
      if (e.key === 'Escape') {
        setHelpOpen(false)
        setNotificationsOpen(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [user, helpOpen, openHelp])

  return (
    <SupportContext.Provider value={{
      helpOpen, activeTab, openHelp, closeHelp,
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
