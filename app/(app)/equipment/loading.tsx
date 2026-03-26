/**
 * Equipment loading boundary.
 * Shown while the equipment route segment is streaming.
 */
export default function EquipmentLoading() {
  return (
    <div
      role="status"
      aria-label="Loading equipment"
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
      Loading equipment…
    </div>
  )
}
