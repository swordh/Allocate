'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { cancelBooking, approveBooking } from '@/actions/bookings'
import BookingStatusBadge from './BookingStatusBadge'
import type { Booking, Equipment, Role } from '@/types'
import styles from './BookingDetail.module.css'

interface BookingDetailProps {
  booking: Booking
  equipment: Equipment[]
  sessionUid: string
  role: Role
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
}: BookingDetailProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectionReason, setRejectionReason] = useState('')

  const isOwner  = booking.userId === sessionUid
  const isAdmin  = role === 'admin'
  const canCancel =
    (isOwner || isAdmin) &&
    (booking.status === 'pending' || booking.status === 'confirmed')
  const canEdit =
    (isOwner || isAdmin) &&
    (booking.status === 'pending' || booking.status === 'confirmed')
  const canApprove =
    (isAdmin || booking.approverId === sessionUid) &&
    booking.status === 'pending' &&
    booking.approvalStatus === 'pending'

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
            ← Bookings
          </Link>
          <h1 className={styles.title}>{booking.projectName}</h1>
          <div className={styles.meta}>
            <BookingStatusBadge
              status={booking.status}
              approvalStatus={booking.approvalStatus}
            />
            <span className={styles.bookedBy}>Booked by {booking.userName}</span>
          </div>
        </div>
        <div className={styles.headerRight}>
          {canEdit && (
            <Link
              href={`/bookings/${booking.id}/edit`}
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
        {/* Details */}
        <div className={styles.details}>
          {/* Dates */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Date Range</div>
            <div className={styles.sectionValue}>{dateRange}</div>
          </div>

          {/* Equipment list */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>
              Equipment ({booking.items.length})
            </div>
            <ul className={styles.itemList}>
              {booking.items.map((item, index) => {
                const eq = findEquipment(item.equipmentId)
                return (
                  <li key={`${item.equipmentId}-${index}`} className={styles.item}>
                    <span className={styles.itemName}>
                      {eq?.name ?? item.equipmentId}
                    </span>
                    <span className={styles.itemQty}>
                      {item.quantity > 1 ? `×${item.quantity}` : ''}
                    </span>
                    {eq?.requiresApproval && (
                      <span className={styles.approvalTag}>Requires approval</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          {/* Notes */}
          {booking.notes && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Notes</div>
              <div className={styles.sectionValue}>{booking.notes}</div>
            </div>
          )}

          {/* Rejection reason */}
          {booking.approvalStatus === 'rejected' && booking.rejectionReason && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Rejection Reason</div>
              <div className={`${styles.sectionValue} ${styles.rejectionText}`}>
                {booking.rejectionReason}
              </div>
            </div>
          )}

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

        {/* Actions panel */}
        <div className={styles.actions}>
          {/* Approve / Reject */}
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
