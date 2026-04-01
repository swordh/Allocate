'use client'

import { useToast } from '@/lib/toast-context'
import styles from './Toast.module.css'

export function ToastContainer() {
  const { toasts, dismissToast } = useToast()

  if (toasts.length === 0) return null

  return (
    <div className={styles.container}>
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.type]}`}>
          {toast.type === 'saving' && <span className={styles.spinner} />}
          <span className={styles.message}>{toast.message}</span>
          {toast.type !== 'saving' && (
            <button className={styles.dismiss} onClick={() => dismissToast(toast.id)}>
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
