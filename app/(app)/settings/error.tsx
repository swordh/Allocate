'use client'

/**
 * Settings error boundary.
 * Catches unhandled errors in the settings route segment and its children.
 * Must be a Client Component — Next.js requires 'use client' on error.tsx.
 */
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '1rem',
        padding: '2rem',
        maxWidth: '480px',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>Failed to load settings.</p>
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-text-secondary, #666)' }}>
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.5rem 1rem',
          fontSize: '0.875rem',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  )
}
