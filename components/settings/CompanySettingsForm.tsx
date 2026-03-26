'use client'

import { useState } from 'react'
import { updateCompanyName } from '@/actions/company'
import styles from './CompanySettingsForm.module.css'

interface CompanySettingsFormProps {
  name: string
}

export default function CompanySettingsForm({ name: initialName }: CompanySettingsFormProps) {
  const [name, setName] = useState(initialName)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setSuccess(false)

    const result = await updateCompanyName(name)

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSuccess(true)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.heading}>Settings</div>
      <div className={styles.subHeading}>Company</div>

      <form onSubmit={handleSubmit} className={styles.form}>
        {/* Company name field */}
        <div className={styles.fieldGroup}>
          <label htmlFor="company-name" className={styles.fieldLabel}>
            Company Name
          </label>
          <input
            id="company-name"
            type="text"
            className={styles.fieldInput}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSuccess(false)
            }}
            maxLength={100}
            required
          />
        </div>

        {/* Logo upload — coming soon */}
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>Logo</span>
          <div className={styles.logoUploadDisabled}>
            <span className={styles.logoUploadText}>Logo upload coming soon</span>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className={styles.errorBanner}>
            {error}
          </div>
        )}

        {/* Success banner */}
        {success && (
          <div className={styles.successBanner}>
            Changes saved.
          </div>
        )}

        <button
          type="submit"
          className={styles.btnSave}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Save Changes'}
        </button>
      </form>
    </div>
  )
}
