'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateUserProfile, deleteAccount, exportUserData } from '@/actions/account'
import { deleteSession } from '@/actions/auth'
import { requestEmailChange, requestPasswordReset } from '@/actions/auth-email'
import { auth } from '@/lib/firebase'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import { BOOKING_VIEW_OPTIONS, BOOKING_VIEW_LABELS, type BookingViewOption } from '@/constants/company'
import styles from './AccountSettingsForm.module.css'

interface AccountSettingsFormProps {
  name: string
  email: string
  defaultBookingView?: BookingViewOption
}

export default function AccountSettingsForm({
  name: initialName,
  email,
  defaultBookingView: initialView,
}: AccountSettingsFormProps) {
  const router = useRouter()

  const [name, setName] = useState(initialName)
  const [defaultBookingView, setDefaultBookingView] = useState<BookingViewOption>(initialView ?? 'list')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [confirmInput, setConfirmInput] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [signingOut, setSigningOut] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Change-email flow: an inline form revealed by "CHANGE EMAIL →".
  const [showEmailChange, setShowEmailChange] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailSubmitting, setEmailSubmitting] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)

  // Change-password flow: sends a reset link to the user's own address.
  // requestPasswordReset is deliberately enumeration-safe (it never returns an
  // error), so the confirmation below is shown unconditionally.
  const [passwordSending, setPasswordSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  function clearSaved() {
    if (saved) setSaved(false)
  }

  async function handleEmailChange() {
    if (emailSubmitting || newEmail.trim().length === 0) return
    setEmailSubmitting(true)
    setEmailError(null)
    try {
      const user = auth.currentUser
      if (!user) {
        setEmailError('Your session expired. Please sign in again.')
        return
      }
      const idToken = await user.getIdToken()
      const result = await requestEmailChange(idToken, newEmail.trim())
      if (result.error) {
        setEmailError(result.error)
      } else {
        setEmailSent(true)
      }
    } catch {
      setEmailError('Something went wrong. Please try again.')
    } finally {
      setEmailSubmitting(false)
    }
  }

  async function handlePasswordReset() {
    setPasswordSending(true)
    try {
      await requestPasswordReset(email)
      setResetSent(true)
    } finally {
      setPasswordSending(false)
    }
  }

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    setSaved(false)

    const result = await updateUserProfile({ name, defaultBookingView })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => setSaved(false), 2600)
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
    } finally {
      setSigningOut(false)
    }
  }

  async function handleExportData() {
    setExporting(true)
    setExportError(null)
    const result = await exportUserData()
    setExporting(false)
    if (result.error) {
      setExportError(result.error)
      return
    }
    const blob = new Blob([result.json!], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'allocate-my-data.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleDeleteAccount() {
    if (confirmInput !== 'DELETE') return
    setDeleting(true)
    setDeleteError(null)

    const result = await deleteAccount()

    if (result.error) {
      setDeleteError(result.error)
      setDeleting(false)
    } else {
      router.push('/login')
    }
  }

  return (
    <div className={styles.container}>
      {/* Name */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Name</div>
          <div className={styles.rowHelp}>Shown on bookings you create.</div>
        </div>
        <div className={styles.rowControl}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              clearSaved()
            }}
            maxLength={100}
            required
          />
        </div>
      </div>

      {/* Email */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Email</div>
          <div className={styles.rowHelp}>Used to sign in. Changing it requires confirming the new address.</div>
        </div>
        <div className={styles.rowControl}>
          <div className={styles.emailValueRow}>
            <div className={styles.emailBox}>
              <span className={styles.emailValue}>{email}</span>
              {!emailSent && (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setShowEmailChange((v) => !v)}
                >
                  {showEmailChange ? 'CANCEL' : 'CHANGE EMAIL →'}
                </button>
              )}
            </div>
            {showEmailChange && !emailSent && (
              <div className={styles.inlineRow}>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="new@address.com"
                  value={newEmail}
                  onChange={(e) => {
                    setNewEmail(e.target.value)
                    setEmailError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleEmailChange()
                    }
                  }}
                  disabled={emailSubmitting}
                  className={styles.flexInput}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleEmailChange}
                  disabled={emailSubmitting || newEmail.trim().length === 0}
                >
                  {emailSubmitting ? 'SENDING…' : 'SEND LINK'}
                </Button>
              </div>
            )}
            {emailError && <ErrorBanner tone="danger">{emailError}</ErrorBanner>}
            {emailSent && (
              <ErrorBanner tone="info">
                We sent a confirmation link to {newEmail.trim()}. The change takes effect once you click it.
              </ErrorBanner>
            )}
          </div>
        </div>
      </div>

      {/* Default view — no design mockup for this row; the design's own
          viewChips helper exists but is unrendered anywhere. Preserved here
          per correction: "defaultBookingView stays on the Account form where
          it already is." Styled to match the surrounding rows. */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Default view</div>
          <div className={styles.rowHelp}>Choose which view opens by default when you navigate to Bookings.</div>
        </div>
        <div className={styles.chipRow}>
          {BOOKING_VIEW_OPTIONS.map((v) => (
            <Chip
              key={v}
              active={defaultBookingView === v}
              onClick={() => {
                setDefaultBookingView(v)
                clearSaved()
              }}
            >
              {BOOKING_VIEW_LABELS[v]}
            </Chip>
          ))}
        </div>
      </div>

      {/* Password & data */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Password &amp; data</div>
          <div className={styles.rowHelp}>Reset your password or download everything we store about you.</div>
        </div>
        <div className={styles.buttonsRow}>
          <Button variant="secondary" size="sm" onClick={handlePasswordReset} disabled={passwordSending}>
            {passwordSending ? 'SENDING…' : 'SEND RESET LINK'}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleExportData} disabled={exporting}>
            {exporting ? 'PREPARING…' : 'EXPORT MY DATA'}
          </Button>
        </div>
      </div>

      {/* Session & account */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Session &amp; account</div>
          <div className={styles.rowHelp}>Sign out on this device, or permanently delete your account.</div>
        </div>
        <div className={styles.buttonsRow}>
          <Button variant="secondary" size="sm" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen((v) => !v)}>
            DELETE ACCOUNT
          </Button>
        </div>
      </div>

      <div className={styles.saveRow}>
        {saved && <span className={styles.saveNote}>ACCOUNT SAVED</span>}
        <Button variant="primary" size="sm" onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      {/* Mobile-only sticky bar — same handler, duplicated per the desktop
          row because the design shows the CTA fixed to the viewport bottom
          on small screens instead of inline. */}
      <div className={styles.stickyBar}>
        <span className={styles.saveNote}>{saved ? 'SAVED' : ''}</span>
        <Button variant="primary" size="lg" fullWidth={false} onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
      {exportError && <ErrorBanner tone="danger">{exportError}</ErrorBanner>}

      {resetSent && (
        <ErrorBanner
          tone="info"
          action={
            <button type="button" className={styles.dismissBtn} onClick={() => setResetSent(false)}>
              DISMISS
            </button>
          }
        >
          Reset link sent to {email}. It expires in 1 hour — check your spam folder if it does not arrive.
        </ErrorBanner>
      )}

      {deleteOpen && (
        <div className={styles.deleteConfirm}>
          <span className={styles.deleteText}>Type DELETE to permanently remove your account.</span>
          <div className={styles.deleteInputRow}>
            <Input
              value={confirmInput}
              onChange={(e) => {
                setConfirmInput(e.target.value)
                setDeleteError(null)
              }}
              placeholder="DELETE"
              className={styles.deleteInput}
            />
            <Button
              variant="danger-solid"
              size="sm"
              onClick={handleDeleteAccount}
              disabled={confirmInput !== 'DELETE' || deleting}
            >
              {deleting ? 'DELETING…' : 'CONFIRM'}
            </Button>
          </div>
          {deleteError && <ErrorBanner tone="danger">{deleteError}</ErrorBanner>}
        </div>
      )}
    </div>
  )
}
