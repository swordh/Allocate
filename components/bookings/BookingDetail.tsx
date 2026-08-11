'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import ErrorBanner from '@/components/ui/ErrorBanner'
import Glyph from '@/components/ui/Glyph'
import StatusDot from '@/components/ui/StatusDot'
import { cancelBooking, checkOutBooking, checkInBooking } from '@/actions/bookings'
import { formatCompactRange, formatDayFull, formatStampInZone } from '@/lib/dates'
import { itemCount, statusColor, statusLabel } from '@/lib/bookings/status'
import type { Booking, Equipment, Role, UserProfile } from '@/types'
import styles from './BookingDetail.module.css'

interface BookingDetailProps {
  booking: Booking
  equipment: Equipment[]
  sessionUid: string
  role: Role
  timezone: string
  userProfile?: UserProfile | null
}

interface DetailLine {
  key: string
  name: string
  quantity: number
  /** "#01", "#01, #03", or "—" for quantity-tracked equipment. */
  units: string
}

/**
 * Booking detail — screen 10.
 *
 * No approve/reject UI: `requiresApproval`, `approvalStatus` and the two
 * server actions stay in place, they simply have no surface until after MVP
 * (decision 1). The check-out pick list that used to live here is gone too,
 * per the 2026-08-11 decision — the design has no place for it.
 */
export default function BookingDetail({
  booking,
  equipment,
  sessionUid,
  role,
  timezone,
  userProfile,
}: BookingDetailProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)

  const isOwner = booking.userId === sessionUid
  const isAdmin = role === 'admin'
  const isOpen = booking.status === 'pending' || booking.status === 'confirmed'

  const canEdit = (isOwner || isAdmin) && isOpen
  const canCancel = (isOwner || isAdmin) && isOpen
  const canCheckOut = isAdmin && booking.status === 'confirmed'
  const canCheckIn = isAdmin && booking.status === 'checked_out'

  function run(action: () => Promise<{ error?: string }>, onDone: () => void) {
    setActionError(null)
    startTransition(async () => {
      const result = await action()
      if (result.error) setActionError(result.error)
      else onDone()
    })
  }

  // Equipment grouped by category, then by equipment, with the units of each
  // line collected — one row per piece of equipment, as the design draws it.
  const groups = useMemo(() => {
    const byCategory = new Map<string, Map<string, DetailLine>>()

    for (const item of booking.items ?? []) {
      const gear = equipment.find((e) => e.id === item.equipmentId)
      const category = gear?.category || 'UNCATEGORISED'
      const name = gear?.name || 'Deleted equipment'

      let lines = byCategory.get(category)
      if (!lines) {
        lines = new Map()
        byCategory.set(category, lines)
      }

      const unitLabel = item.unitId
        ? gear?.units?.find((u) => u.id === item.unitId)?.label ?? '#??'
        : ''

      const existing = lines.get(item.equipmentId)
      if (existing) {
        existing.quantity += item.quantity
        if (unitLabel) existing.units = existing.units === '—' ? unitLabel : `${existing.units}, ${unitLabel}`
      } else {
        lines.set(item.equipmentId, {
          key: item.equipmentId,
          name,
          quantity: item.quantity,
          units: unitLabel || '—',
        })
      }
    }

    return Array.from(byCategory.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, lines]) => ({ category, lines: Array.from(lines.values()) }))
  }, [booking.items, equipment])

  const typeCount = groups.reduce((sum, g) => sum + g.lines.length, 0)
  const color = statusColor(booking.status)
  const timeLabel = booking.startTime && booking.endTime ? null : 'Full day'

  return (
    <div className={styles.page}>
      <Link href="/bookings" className={styles.back}>
        <Glyph char="‹" /> BACK TO BOOKINGS
      </Link>

      <h1 className={styles.title}>{booking.projectName}</h1>

      {actionError && <ErrorBanner>{actionError}</ErrorBanner>}

      <div className={styles.body}>
        <div className={styles.main}>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>WHEN</h2>
            <div className={styles.whenRow}>
              <div className={styles.dateCard}>
                <span className={styles.dateLabel}>PICKUP</span>
                <span className={styles.dateValue}>{formatDayFull(booking.startDate)}</span>
                <span className={styles.dateHint}>{timeLabel ?? booking.startTime}</span>
              </div>
              <Glyph char="→" className={styles.arrow} />
              <div className={styles.dateCard}>
                <span className={styles.dateLabel}>RETURN</span>
                <span className={styles.dateValue}>{formatDayFull(booking.endDate)}</span>
                <span className={styles.dateHint}>{timeLabel ?? booking.endTime}</span>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>EQUIPMENT</h2>
              <span className={styles.sectionMeta}>
                {itemCount(booking)} ITEMS · {typeCount} {typeCount === 1 ? 'TYPE' : 'TYPES'}
              </span>
            </div>

            {groups.map((group) => (
              <div key={group.category} className={styles.group}>
                <p className={styles.groupLabel}>{group.category.toUpperCase()}</p>
                <div className={styles.lines}>
                  {group.lines.map((line) => (
                    <div key={line.key} className={styles.line}>
                      <span className={styles.lineName}>{line.name}</span>
                      <span className={styles.lineUnits}>{line.units}</span>
                      <span className={styles.lineQty}>×{line.quantity}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          {booking.notes && (
            <section className={`${styles.section} ${styles.sectionLast}`}>
              <h2 className={styles.sectionTitle}>NOTES</h2>
              <p className={styles.notes}>{booking.notes}</p>
            </section>
          )}
        </div>

        <aside className={styles.aside}>
          <div>
            <p className={styles.asideLabel}>STATUS</p>
            <p className={styles.status} style={{ color }}>
              <StatusDot size={7} />
              {statusLabel(booking.status)}
            </p>
          </div>

          <div>
            <p className={styles.asideLabel}>CREATED BY</p>
            <p className={styles.creator}>{userProfile?.name ?? 'Deleted user'}</p>
            {booking.createdAt && (
              <p className={styles.created}>{formatStampInZone(booking.createdAt, timezone)}</p>
            )}
          </div>

          <div className={styles.divider} />

          <div className={styles.actions}>
            {canCheckOut && (
              <Button fullWidth onClick={() => run(() => checkOutBooking(booking.id), router.refresh)} disabled={isPending}>
                CHECK OUT
              </Button>
            )}
            {canCheckIn && (
              <Button fullWidth onClick={() => run(() => checkInBooking(booking.id), router.refresh)} disabled={isPending}>
                CHECK IN
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" size="sm" fullWidth href={`/bookings/${booking.id}?edit=1`}>
                EDIT BOOKING
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" size="sm" fullWidth onClick={() => setCancelOpen(true)} disabled={isPending}>
                CANCEL BOOKING
              </Button>
            )}

            {(canCheckOut || canCheckIn) && (
              <p className={styles.actionHint}>
                Admin actions for a {statusLabel(booking.status).toLowerCase()} booking
              </p>
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        title="CANCEL BOOKING?"
        body={`Cancelling this booking (${formatCompactRange(booking.startDate, booking.endDate)}) will release all reserved equipment. This can't be undone.`}
        confirmLabel="YES, CANCEL"
        cancelLabel="GO BACK"
        busy={isPending}
        onCancel={() => setCancelOpen(false)}
        onConfirm={() =>
          run(() => cancelBooking(booking.id), () => {
            setCancelOpen(false)
            router.push('/bookings')
          })
        }
      />
    </div>
  )
}
