'use client'

import { useEffect, useRef } from 'react'
import { useSupportContext } from '@/lib/support-context'
import styles from './NotificationsPanel.module.css'

export default function NotificationsPanel() {
  const { notificationsOpen, closeNotifications } = useSupportContext()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!notificationsOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeNotifications()
      }
    }
    setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [notificationsOpen, closeNotifications])

  return (
    <div
      ref={panelRef}
      className={`${styles.panel} ${notificationsOpen ? styles.panelOpen : ''}`}
      role="dialog"
      aria-label="Notifications"
      aria-hidden={!notificationsOpen}
    >
      <div className={styles.header}>
        <span className={styles.title}>Notifications</span>
        <button className={styles.closeBtn} onClick={closeNotifications} aria-label="Close notifications">
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.emptyState}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`}>notifications</span>
          <p className={styles.emptyText}>You're all caught up</p>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.footerLink}>Notification settings</button>
      </div>
    </div>
  )
}
