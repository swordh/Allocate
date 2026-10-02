'use client'

import { useState } from 'react'
import { updatePreferences } from '@/actions/company'
import { TIME_SLOT_OPTIONS, TIME_SLOT_LABELS } from '@/constants/company'
import Checkbox from '@/components/ui/Checkbox'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { CompanyPreferences } from '@/types'
import styles from './PreferencesForm.module.css'

interface PreferencesFormProps {
  preferences: CompanyPreferences
}

/**
 * Booking time-slot size, plus the automatic check-out / check-in switches
 * (#329). Everything applies immediately on click, no separate Save Changes
 * step — matches the design, which shows no save button or note for this
 * section (only Account and Company get one).
 *
 * Timezone has no input here (it lives on Company) but is shown in the help
 * text, because it decides what "start time" means for the automation.
 * updatePreferences accepts a Partial, so each control only ever sends its own
 * key and can't clobber the others.
 */
export default function PreferencesForm({ preferences: initial }: PreferencesFormProps) {
  const [bookingTimeSlotMinutes, setBookingTimeSlotMinutes] = useState(initial.bookingTimeSlotMinutes)
  const [autoCheckout, setAutoCheckout] = useState(initial.autoCheckout)
  const [autoCheckin, setAutoCheckin] = useState(initial.autoCheckin)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timezone = initial.timezone

  async function handlePick(value: number) {
    if (value === bookingTimeSlotMinutes || saving) return
    const previous = bookingTimeSlotMinutes
    setBookingTimeSlotMinutes(value)
    setSaving(true)
    setError(null)

    const result = await updatePreferences({ bookingTimeSlotMinutes: value })

    setSaving(false)

    if (result.error) {
      setError(result.error)
      setBookingTimeSlotMinutes(previous)
    }
  }

  async function handleToggle(key: 'autoCheckout' | 'autoCheckin', value: boolean) {
    if (saving) return
    const set = key === 'autoCheckout' ? setAutoCheckout : setAutoCheckin
    const previous = key === 'autoCheckout' ? autoCheckout : autoCheckin
    set(value)
    setSaving(true)
    setError(null)

    const result = await updatePreferences({ [key]: value })

    setSaving(false)

    if (result.error) {
      setError(result.error)
      set(previous)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Time slot size</div>
          <div className={styles.rowHelp}>
            Pickup and return times are offered in {TIME_SLOT_LABELS[bookingTimeSlotMinutes].toLowerCase()} steps
            when a booking is not full-day.
          </div>
        </div>
        {/* Desktop: dark-fill active chip. Mobile: white/black solid — matches
            the design's mobile chip() helper, distinct from the desktop one.
            Two renders, CSS picks one (same pattern as TeamSettingsView). */}
        <div className={`${styles.chipRow} ${styles.deskOnly}`}>
          {TIME_SLOT_OPTIONS.map((value) => (
            <Chip
              key={value}
              active={bookingTimeSlotMinutes === value}
              onClick={() => handlePick(value)}
              disabled={saving}
            >
              {TIME_SLOT_LABELS[value]}
            </Chip>
          ))}
        </div>
        <div className={`${styles.chipRow} ${styles.mobileOnly}`}>
          {TIME_SLOT_OPTIONS.map((value) => (
            <Chip
              key={value}
              variant="solid"
              active={bookingTimeSlotMinutes === value}
              onClick={() => handlePick(value)}
              disabled={saving}
            >
              {TIME_SLOT_LABELS[value]}
            </Chip>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Automatic check-out</div>
          <div className={styles.rowHelp}>
            Checks out bookings at their start time in your company time zone ({timezone}). Applies to bookings
            from now on.
          </div>
        </div>
        <div className={styles.toggleCell}>
          <Checkbox
            checked={autoCheckout}
            onChange={(checked) => handleToggle('autoCheckout', checked)}
            label="Check out automatically"
            disabled={saving}
          />
        </div>
      </div>

      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Automatic check-in</div>
          <div className={styles.rowHelp}>
            Checks in bookings at their end time in your company time zone ({timezone}). Applies to bookings
            from now on.
          </div>
        </div>
        <div className={styles.toggleCell}>
          <Checkbox
            checked={autoCheckin}
            onChange={(checked) => handleToggle('autoCheckin', checked)}
            label="Check in automatically"
            disabled={saving}
          />
        </div>
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
    </div>
  )
}
