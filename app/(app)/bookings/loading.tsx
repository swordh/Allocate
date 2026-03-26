/**
 * Bookings loading boundary.
 * Shown while any bookings route segment is streaming.
 */
export default function BookingsLoading() {
  return (
    <div
      role="status"
      aria-label="Loading bookings"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
        fontSize: '0.875rem',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--color-text-secondary, #666)',
      }}
    >
      Loading bookings…
    </div>
  )
}
