'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { cancelBooking, approveBooking, checkOutBooking, checkInBooking } from '@/actions/bookings'
import BookingStatusBadge from './BookingStatusBadge'
import type { Booking, Equipment, Role, UserProfile } from '@/types'
import styles from './BookingDetail.module.css'

interface BookingDetailProps {
  booking: Booking
  equipment: Equipment[]
  sessionUid: string
  role: Role
  userProfile?: UserProfile | null
}

/**
 * Booking detail — Client Component.
 * Handles approve/reject/cancel mutations with optimistic UI.
 */
export default function BookingDetail({
  booking,
  equipment,
  sessionUid,
  role,
  userProfile,
}: BookingDetailProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectionReason, setRejectionReason] = useState('')
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set())

  const isOwner  = booking.userId === sessionUid
  const isAdmin  = role === 'admin'
  const canCancel =
    (isOwner || isAdmin) &&
    (booking.status === 'pending' || booking.status === 'confirmed')
  const canCheckOut = isAdmin && booking.status === 'confirmed'
  const canCheckIn  = isAdmin && booking.status === 'checked_out'
  const canEdit =
    (isOwner || isAdmin) &&
    (booking.status === 'pending' || booking.status === 'confirmed')
  const canApprove =
    (isAdmin || booking.approverId === sessionUid) &&
    booking.status === 'pending' &&
    booking.approvalStatus === 'pending'

  const canPickList =
    booking.status === 'confirmed' || booking.status === 'checked_out'

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleCancel() {
    setActionError(null)
    startTransition(async () => {
      const result = await cancelBooking(booking.id)
      if (result.error) {
        setActionError(result.error)
      } else {
        router.push('/bookings')
      }
    })
  }

  function handleCheckOut() {
    setActionError(null)
    startTransition(async () => {
      const result = await checkOutBooking(booking.id)
      if (result.error) {
        setActionError(result.error)
      } else {
        router.refresh()
      }
    })
  }

  function handleCheckIn() {
    setActionError(null)
    startTransition(async () => {
      const result = await checkInBooking(booking.id)
      if (result.error) {
        setActionError(result.error)
      } else {
        router.refresh()
      }
    })
  }

  function handleApprove() {
    setActionError(null)
    startTransition(async () => {
      const result = await approveBooking(booking.id, true)
      if (result.error) {
        setActionError(result.error)
      } else {
        router.refresh()
      }
    })
  }

  function handleReject() {
    setActionError(null)
    startTransition(async () => {
      const result = await approveBooking(booking.id, false, rejectionReason || undefined)
      if (result.error) {
        setActionError(result.error)
      } else {
        setShowRejectForm(false)
        router.refresh()
      }
    })
  }

  function togglePickedItem(key: string) {
    setPickedItems((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Equipment lookup
  // ---------------------------------------------------------------------------

  function findEquipment(id: string): Equipment | undefined {
    return equipment.find((e) => e.id === id)
  }

  // ---------------------------------------------------------------------------
  // Date formatting
  // ---------------------------------------------------------------------------

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  }

  const dateRange =
    booking.startDate === booking.endDate
      ? formatDate(booking.startDate)
      : `${formatDate(booking.startDate)} — ${formatDate(booking.endDate)}`

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href="/bookings" className={styles.backLink}>
            &larr; Bookings
          </Link>
          <h1 className={styles.title}>{booking.projectName}</h1>
          <div className={styles.meta}>
            <BookingStatusBadge
              status={booking.status}
              approvalStatus={booking.approvalStatus}
            />
            <span className={styles.bookedBy}>
              Booked by {userProfile?.name ?? booking.userName}
            </span>
          </div>
        </div>
        <div className={styles.headerRight}>
          {canEdit && (
            <Link
              href={`/bookings/${booking.id}?edit=1`}
              className={styles.editLink}
            >
              Edit
            </Link>
          )}
        </div>
      </div>

      {actionError && (
        <div className={styles.errorBanner}>{actionError}</div>
      )}

      <div className={styles.body}>
        {/* Left column: pick list + ancillary info */}
        <div className={styles.details}>
          {/* Pick List */}
          <div className={styles.section}>
            <div className={styles.pickListHeader}>
              <div className={styles.sectionLabel}>Pick List</div>
              {canPickList && (
                <div className={styles.pickListProgress}>
                  {pickedItems.size} / {booking.items.length} items
                </div>
              )}
            </div>
            <ul className={styles.pickList}>
              {booking.items.map((item, index) => {
                const key = `${item.equipmentId}-${index}`
                const eq = findEquipment(item.equipmentId)
                const isPicked = pickedItems.has(key)
                const unit = eq?.units?.find((u) => u.id === item.unitId) ?? null

                return (
                  <li
                    key={key}
                    className={`${styles.pickItem} ${canPickList ? styles.pickItemInteractive : ''}`}
                    onClick={() => canPickList && togglePickedItem(key)}
                  >
                    <span
                      className={`${styles.pickCheckbox} ${isPicked ? styles.pickCheckboxChecked : ''}`}
                      aria-hidden="true"
                    >
                      {isPicked && <span className={styles.pickCheckIcon}>&#10003;</span>}
                    </span>
                    <span className={styles.pickItemContent}>
                      <span
                        className={`${styles.pickItemName} ${isPicked ? styles.pickItemNamePicked : ''}`}
                      >
                        {eq
                          ? eq.active !== false
                            ? eq.name
                            : `${eq.name} (deleted)`
                          : item.equipmentId}
                      </span>
                      <span className={styles.pickItemMeta}>
                        {eq?.category ?? ''}
                        {eq?.trackingType === 'quantity' && item.quantity > 1
                          ? <span className={styles.pickItemQty}>&times;{item.quantity}</span>
                          : null}
                        {eq?.trackingType === 'serialized' && unit
                          ? (
                            <span className={styles.pickItemUnit}>
                              {unit.active !== false
                                ? unit.label
                                : `${unit.label} (deleted)`}
                              {unit.serialNumber ? ` · ${unit.serialNumber}` : ''}
                            </span>
                          )
                          : null}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* Rejection reason — hidden for MVP
          {booking.approvalStatus === 'rejected' && booking.rejectionReason && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Rejection Reason</div>
              <div className={`${styles.sectionValue} ${styles.rejectionText}`}>
                {booking.rejectionReason}
              </div>
            </div>
          )}
          */}

          {/* Cancellation info */}
          {booking.status === 'cancelled' && booking.cancelledAt && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Cancelled</div>
              <div className={styles.sectionValue}>
                {new Date(booking.cancelledAt).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </div>
            </div>
          )}

          {/* Created at */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Created</div>
            <div className={styles.sectionValue}>
              {booking.createdAt
                ? new Date(booking.createdAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })
                : '—'}
            </div>
          </div>
        </div>

        {/* Right column: summary + actions */}
        <div className={styles.actions}>
          {/* Date range */}
          <div className={styles.actionSection}>
            <div className={styles.sectionLabel}>Date Range</div>
            <div className={styles.sectionValue}>{dateRange}</div>
          </div>

          {/* Time */}
          {(booking.startTime || booking.endTime) && (
            <div className={styles.actionSection}>
              <div className={styles.sectionLabel}>Time</div>
              <div className={styles.sectionValue}>
                {booking.startTime ?? '—'} &rarr; {booking.endTime ?? '—'}
              </div>
            </div>
          )}

          {/* Notes */}
          {booking.notes && (
            <div className={styles.actionSection}>
              <div className={styles.sectionLabel}>Notes</div>
              <div className={styles.sectionValue}>{booking.notes}</div>
            </div>
          )}

          <div className={styles.actionDivider} />

          {/* Approve / Reject — hidden for MVP, re-enable in Phase 5
          {canApprove && (
            <div className={styles.approvalSection}>
              <div className={styles.approvalLabel}>Approval Required</div>
              <div className={styles.approvalButtons}>
                <button
                  className={styles.approveBtn}
                  onClick={handleApprove}
                  disabled={isPending}
                >
                  Approve
                </button>
                <button
                  className={styles.rejectBtn}
                  onClick={() => setShowRejectForm((v) => !v)}
                  disabled={isPending}
                >
                  Reject
                </button>
              </div>
              {showRejectForm && (
                <div className={styles.rejectForm}>
                  <label className={styles.rejectLabel} htmlFor="rejectionReason">
                    Reason (optional)
                  </label>
                  <textarea
                    id="rejectionReason"
                    className={styles.rejectTextarea}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Explain why the booking was rejected..."
                  />
                  <button
                    className={styles.rejectConfirmBtn}
                    onClick={handleReject}
                    disabled={isPending}
                  >
                    Confirm Rejection
                  </button>
                </div>
              )}
            </div>
          )} */}

          {/* Check out */}
          {canCheckOut && (
            <button
              className={styles.checkOutBtn}
              onClick={handleCheckOut}
              disabled={isPending}
            >
              Check Out
            </button>
          )}

          {/* Check in */}
          {canCheckIn && (
            <button
              className={styles.checkInBtn}
              onClick={handleCheckIn}
              disabled={isPending}
            >
              Check In
            </button>
          )}

          {/* Cancel booking */}
          {canCancel && (
            <button
              className={styles.cancelBtn}
              onClick={handleCancel}
              disabled={isPending}
            >
              Cancel Booking
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
