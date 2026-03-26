/**
 * App-level loading boundary.
 * Shown while any (app) route segment is streaming.
 * Server Component — no 'use client' needed.
 */
export default function AppLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        fontSize: '0.875rem',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--color-text-secondary, #666)',
      }}
    >
      Loading…
    </div>
  )
}
