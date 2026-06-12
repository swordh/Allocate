'use client'

import { useState } from 'react'
import Link from 'next/link'
import { requestPasswordReset } from '@/actions/auth-email'
import styles from './Auth.module.css'

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      // Always resolves with { ok: true } — the action never reveals whether
      // the address has an account (enumeration protection).
      await requestPasswordReset(email.trim())
      setSent(true)
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h1 className={styles.pageTitle}>CHECK YOUR EMAIL</h1>
          <p>
            If an account exists for <strong>{email.trim()}</strong>, we’ve sent a
            link to reset your password.
          </p>
          <p className={styles.footer}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.formCard}>
        <h1 className={styles.pageTitle}>RESET PASSWORD</h1>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">Email</label>
            <input
              id="email"
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>

        <p className={styles.footer}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
