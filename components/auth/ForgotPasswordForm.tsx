'use client'

import { useState } from 'react'
import Link from 'next/link'
import { requestPasswordReset } from '@/actions/auth-email'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Field from '@/components/ui/Field'
import ErrorBanner from '@/components/ui/ErrorBanner'
import styles from './ForgotPasswordForm.module.css'

const THROTTLED_MESSAGE = 'Too many reset requests. Wait 15 minutes before trying again.'

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [throttled, setThrottled] = useState(false)

  async function send() {
    setLoading(true)
    const result = await requestPasswordReset(email.trim())
    setLoading(false)
    if (result.throttled) {
      setThrottled(true)
      setSent(false)
      return
    }
    setThrottled(false)
    setSent(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await send()
  }

  if (sent) {
    return (
      <AuthShell>
        <AuthCard width={400} gap={24}>
          <div className={styles.sentTitleBlock}>
            <span className={styles.eyebrow}>LINK SENT</span>
            <h1 className={styles.sentTitle}>Check your inbox</h1>
            <span className={styles.sentBody}>
              We sent a reset link to <strong>{email.trim()}</strong>. It expires in 60 minutes
              and can only be used once.
            </span>
          </div>

          <div className={styles.actions}>
            <Button variant="secondary" size="lg" fullWidth loading={loading} onClick={send}>
              {loading ? 'Sending…' : 'Resend link'}
            </Button>
            <Link className={styles.linkButton} href="/login">
              Back to sign in
            </Link>
          </div>

          <span className={styles.fineprint}>
            Nothing after a few minutes? Check spam, or ask an admin in your workspace to confirm
            the address on your account.
          </span>
        </AuthCard>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <AuthCard width={400}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>Reset password</h1>
          <span className={styles.subtitle}>
            Enter your email and we&apos;ll send a link to set a new password.
          </span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {throttled && <ErrorBanner tone="danger">{THROTTLED_MESSAGE}</ErrorBanner>}

          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              inputSize="lg"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              invalid={throttled}
              busy={loading}
            />
          </Field>

          <Button type="submit" size="lg" fullWidth loading={loading}>
            {loading ? 'Sending link…' : 'Email me a reset link'}
          </Button>
        </form>

        <span className={styles.footerText}>
          Remembered it?{' '}
          <Link className={styles.link} href="/login">
            Back to sign in
          </Link>
        </span>
      </AuthCard>
    </AuthShell>
  )
}
