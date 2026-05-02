'use client'

import { useToast } from '@/lib/toast-context'
import styles from './Toast.module.css'

export function ToastContainer() {
  const { toasts, dismissToast } = useToast()

  const savingToast = toasts.find((t) => t.type === 'saving')
  const inlineToasts = toasts.filter((t) => t.type !== 'saving')

  return (
    <>
      {/* Saving overlay — dims background and centers message */}
      {savingToast && (
        <div className={styles.savingOverlay}>
          <div className={styles.savingBox}>
            <span className={styles.spinner} />
            <span>{savingToast.message}</span>
          </div>
        </div>
      )}

      {/* Success / error toasts — bottom center, no overlay */}
      {inlineToasts.length > 0 && (
        <div className={styles.container}>
          {inlineToasts.map((toast) => (
            <div key={toast.id} className={`${styles.toast} ${styles[toast.type]}`}>
              <span className={styles.message}>{toast.message}</span>
              <button className={styles.dismiss} onClick={() => dismissToast(toast.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
