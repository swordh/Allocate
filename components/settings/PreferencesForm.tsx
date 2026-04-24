'use client'

import { useState } from 'react'
import { updatePreferences } from '@/actions/company'
import { TIME_SLOT_OPTIONS, TIME_SLOT_LABELS, TIMEZONE_OPTIONS } from '@/constants/company'
import type { CompanyPreferences } from '@/types'
import styles from './PreferencesForm.module.css'

interface PreferencesFormProps {
  preferences: CompanyPreferences
}

export default function PreferencesForm({ preferences: initial }: PreferencesFormProps) {
  const [bookingTimeSlotMinutes, setBookingTimeSlotMinutes] = useState(initial.bookingTimeSlotMinutes)
  const [autoCheckout, setAutoCheckout] = useState(initial.autoCheckout)
  const [autoCheckin, setAutoCheckin] = useState(initial.autoCheckin)
  const [timezone, setTimezone] = useState(initial.timezone ?? 'UTC')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setSuccess(false)

    const result = await updatePreferences({ bookingTimeSlotMinutes, autoCheckout, autoCheckin, timezone })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSuccess(true)
    }
  }

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.form}>

        {/* Booking Time Slots */}
        <div>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Booking Time Slots</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <div className={styles.box}>
            <p className={styles.boxDescription}>
              Set the minimum time increment used when creating bookings.
            </p>
            <div className={styles.radioGroups}>
              {[
                TIME_SLOT_OPTIONS.filter(v => v > 0 && v < 60),
                TIME_SLOT_OPTIONS.filter(v => v >= 60 || v === -1),
              ].map((group, gi) => (
                <div key={gi} className={styles.radioGroup}>
                  {group.map((value, index) => {
                    const isActive = bookingTimeSlotMinutes === value
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`${styles.radioOption} ${isActive ? styles.radioOptionActive : ''} ${index > 0 ? styles.radioOptionNoLeftBorder : ''}`}
                        onClick={() => { setBookingTimeSlotMinutes(value); setSuccess(false) }}
                      >
                        {TIME_SLOT_LABELS[value]}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Timezone */}
        <div>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Timezone</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <div className={styles.box}>
            <p className={styles.boxDescription}>
              Used for automatic checkout and checkin. Bookings transition at their scheduled local time.
            </p>
            <select
              className={styles.timezoneSelect}
              value={timezone}
              onChange={(e) => { setTimezone(e.target.value); setSuccess(false) }}
            >
              {TIMEZONE_OPTIONS.map(({ label, value }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Automatic Status Changes */}
        <div>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Automatic Status Changes</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <div className={styles.box}>
            <p className={styles.boxDescription}>
              When enabled, bookings are automatically marked as Checked Out / Checked In at their scheduled start and end time.
            </p>

            <div className={styles.toggleRow}>
              <span className={styles.toggleLabel}>Auto Checkout</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoCheckout}
                className={`${styles.toggle} ${autoCheckout ? styles.toggleOn : ''}`}
                onClick={() => {
                  setAutoCheckout((v) => !v)
                  setSuccess(false)
                }}
              >
                <div className={styles.toggleThumb} />
              </button>
            </div>

            <div className={`${styles.toggleRow} ${styles.toggleRowLast}`}>
              <span className={styles.toggleLabel}>Auto Checkin</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoCheckin}
                className={`${styles.toggle} ${autoCheckin ? styles.toggleOn : ''}`}
                onClick={() => {
                  setAutoCheckin((v) => !v)
                  setSuccess(false)
                }}
              >
                <div className={styles.toggleThumb} />
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
    </div>
  )
}
