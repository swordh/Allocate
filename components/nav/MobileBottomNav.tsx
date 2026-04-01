'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './MobileBottomNav.module.css'

interface MobileBottomNavProps {
  role: 'admin' | 'member' | 'viewer'
}

export function MobileBottomNav({ role }: MobileBottomNavProps) {
  const pathname = usePathname()
  const isActive = (path: string) => pathname.startsWith(path)
  return (
    <nav className={styles.nav}>
      <Link href="/bookings" className={`${styles.item} ${isActive('/bookings') ? styles.itemActive : ''}`}>
        <span className="material-symbols-outlined">calendar_today</span>
        <span className={styles.label}>BOOKINGS</span>
      </Link>
      <Link href="/equipment" className={`${styles.item} ${isActive('/equipment') ? styles.itemActive : ''}`}>
        <span className="material-symbols-outlined">construction</span>
        <span className={styles.label}>EQUIPMENT</span>
      </Link>
      {role === 'admin' && (
        <Link href="/settings" className={`${styles.item} ${isActive('/settings') ? styles.itemActive : ''}`}>
          <span className="material-symbols-outlined">settings</span>
          <span className={styles.label}>SETTINGS</span>
        </Link>
      )}
    </nav>
  )
}
