'use client'

import { useState } from 'react'
import { updatePreferences } from '@/actions/company'
import { TIME_SLOT_OPTIONS, TIME_SLOT_LABELS } from '@/constants/company'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { CompanyPreferences } from '@/types'
import styles from './PreferencesForm.module.css'

interface PreferencesFormProps {
  preferences: CompanyPreferences
}

/**
 * Single row: booking time-slot size. Applies immediately on chip click, no
 * separate Save Changes step — matches the design, which shows no save
 * button or note for this section (only Account and Company get one).
 *
 * autoCheckout/autoCheckin and timezone have no UI here anymore (timezone
 * moved to Company; auto-checkout/in have no design at all) but keep their
 * stored values, since updatePreferences accepts a Partial and this
 * component only ever sends bookingTimeSlotMinutes.
 */
export default function PreferencesForm({ preferences: initial }: PreferencesFormProps) {
  const [bookingTimeSlotMinutes, setBookingTimeSlotMinutes] = useState(initial.bookingTimeSlotMinutes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        <div className={styles.chipRow}>
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
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
    </div>
  )
}
