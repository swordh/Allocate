'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateUserProfile, deleteAccount, exportUserData } from '@/actions/account'
import { deleteSession } from '@/actions/auth'
import styles from './AccountSettingsForm.module.css'

interface AccountSettingsFormProps {
  name: string
  email: string
  defaultBookingView?: 'list' | 'week' | 'month' | '4weeks'
}

export default function AccountSettingsForm({
  name: initialName,
  email,
  defaultBookingView: initialView,
}: AccountSettingsFormProps) {
  const router = useRouter()

  const [name, setName] = useState(initialName)
  const [defaultBookingView, setDefaultBookingView] = useState<'list' | 'week' | 'month' | '4weeks'>(
    initialView ?? 'list'
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [confirmInput, setConfirmInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [signingOut, setSigningOut] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setSuccess(false)

    const result = await updateUserProfile({ name, defaultBookingView })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSuccess(true)
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    await deleteSession()
    router.push('/login')
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
      <form onSubmit={handleSubmit} className={styles.form}>

        {/* Default Booking View */}
        <div>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Default Booking View</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <div className={styles.box}>
            <p className={styles.boxDescription}>
              Choose which view opens by default when you navigate to Bookings.
            </p>
            <div className={styles.viewToggle}>
              <button
                type="button"
                className={`${styles.viewToggleOption} ${defaultBookingView === 'list' ? styles.viewToggleOptionActive : ''}`}
                onClick={() => {
                  setDefaultBookingView('list')
                  setSuccess(false)
                }}
              >
                List
              </button>
              <button
                type="button"
                className={`${styles.viewToggleOption} ${styles.viewToggleOptionMiddle} ${defaultBookingView === 'week' ? styles.viewToggleOptionActive : ''}`}
                onClick={() => {
                  setDefaultBookingView('week')
                  setSuccess(false)
                }}
              >
                Week
              </button>
              <button
                type="button"
                className={`${styles.viewToggleOption} ${styles.viewToggleOptionMiddle} ${defaultBookingView === 'month' ? styles.viewToggleOptionActive : ''}`}
                onClick={() => {
                  setDefaultBookingView('month')
                  setSuccess(false)
                }}
              >
                Month
              </button>
              <button
                type="button"
                className={`${styles.viewToggleOption} ${styles.viewToggleOptionRight} ${defaultBookingView === '4weeks' ? styles.viewToggleOptionActive : ''}`}
                onClick={() => {
                  setDefaultBookingView('4weeks')
                  setSuccess(false)
                }}
              >
                4 Weeks
              </button>
            </div>
          </div>
        </div>

        {/* Profile */}
        <div>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Profile</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <div className={styles.box}>

            {/* Display Name */}
            <div className={styles.profileFieldGroup}>
              <div className={styles.profileNameField}>
                <label htmlFor="display-name" className={styles.profileFieldLabel}>
                  Display Name
                </label>
                <input
                  id="display-name"
                  type="text"
                  className={styles.profileNameInput}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setSuccess(false)
                  }}
                  maxLength={100}
                  required
                />
              </div>
            </div>

            {/* Email */}
            <div className={styles.profileInfoGroup}>
              <span className={styles.profileFieldLabel}>Email</span>
              <p className={styles.profileValue}>{email}</p>
              <button type="button" className={styles.btnTextLink}>
                Change Email →
              </button>
            </div>

            {/* Password */}
            <div className={styles.profileInfoGroup}>
              <span className={styles.profileFieldLabel}>Password</span>
              <p className={styles.profileValue}>••••••••••••</p>
              <button type="button" className={styles.btnTextLink}>
                Change Password →
              </button>
            </div>

          </div>
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}
        {success && <div className={styles.successBanner}>Changes saved.</div>}

        <button type="submit" className={styles.btnSave} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save Changes'}
        </button>
      </form>

      <div className={styles.divider} />

      {/* Your Data */}
      <div>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderLabel}>Your Data</span>
          <div className={styles.sectionHeaderLine} />
        </div>
        <div className={styles.box}>
          <p className={styles.boxDescription}>
            Download a copy of all personal data we hold for your account,
            including your profile, company memberships, and bookings.
          </p>
          <button
            type="button"
            className={styles.btnSignOut}
            onClick={handleExportData}
            disabled={exporting}
          >
            {exporting ? 'Preparing…' : 'Download my data'}
          </button>
          {exportError && <div className={styles.errorBanner} style={{ marginTop: 16 }}>{exportError}</div>}
        </div>
      </div>

      <div className={styles.divider} />

      {/* Danger Zone */}
      <div>
        <div className={styles.sectionHeader}>
          <span className={`${styles.sectionHeaderLabel} ${styles.sectionHeaderLabelDanger}`}>
            Danger Zone
          </span>
          <div className={styles.sectionHeaderLine} />
        </div>
        <div className={`${styles.box} ${styles.boxDanger}`}>

          {/* Sign Out row */}
          <div className={styles.dangerRow}>
            <div>
              <p className={styles.dangerTitle}>Sign Out</p>
              <p className={styles.dangerDescription}>Sign out of your account on this device.</p>
            </div>
            <button
              type="button"
              className={styles.btnSignOut}
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out…' : 'Sign Out'}
            </button>
          </div>

          {/* Delete Account row */}
          <div className={styles.dangerRow}>
            <div>
              <p className={`${styles.dangerTitle} ${styles.dangerTitleError}`}>Delete Account</p>
              <p className={`${styles.dangerDescription} ${styles.dangerDescriptionError}`}>
                Permanently delete your account and all associated data. This cannot be undone.
              </p>
            </div>
            <button
              type="button"
              className={styles.btnDanger}
              onClick={handleDeleteAccount}
              disabled={confirmInput !== 'DELETE' || deleting}
            >
              {deleting ? 'Deleting…' : 'Delete Account'}
            </button>
          </div>

          {/* DELETE confirmation input */}
          <div className={styles.confirmRow}>
            <input
              type="text"
              className={styles.confirmInput}
              placeholder='Type "DELETE" to confirm'
              value={confirmInput}
              onChange={(e) => {
                setConfirmInput(e.target.value)
                setDeleteError(null)
              }}
            />
          </div>

          {deleteError && <div className={styles.errorBanner}>{deleteError}</div>}
        </div>
      </div>
    </div>
  )
}
