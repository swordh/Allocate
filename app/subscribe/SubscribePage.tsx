'use client'

import { useState } from 'react'
import { createCheckoutSession } from '@/actions/subscription'

export default function SubscribePage() {
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [coupon, setCoupon] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubscribe() {
    setLoading(true)
    setError(null)
    const result = await createCheckoutSession(interval, coupon || undefined)
    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Subscribe to Allocate</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Choose a billing interval to get started.</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => setInterval('month')}
          style={{
            flex: 1,
            padding: '12px 0',
            borderRadius: 8,
            border: interval === 'month' ? '2px solid #000' : '1px solid #ddd',
            fontWeight: interval === 'month' ? 600 : 400,
            background: 'white',
            cursor: 'pointer',
          }}
        >
          Monthly
        </button>
        <button
          onClick={() => setInterval('year')}
          style={{
            flex: 1,
            padding: '12px 0',
            borderRadius: 8,
            border: interval === 'year' ? '2px solid #000' : '1px solid #ddd',
            fontWeight: interval === 'year' ? 600 : 400,
            background: 'white',
            cursor: 'pointer',
          }}
        >
          Yearly
        </button>
      </div>

      {error && (
        <p style={{ color: 'red', marginBottom: 16 }}>{error}</p>
      )}

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 14, marginBottom: 6, fontWeight: 500 }}>
          Discount code (optional)
        </label>
        <input
          type="text"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value.toUpperCase())}
          placeholder="Enter coupon code"
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid #ddd',
            fontSize: 14,
            fontFamily: 'monospace',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <button
        onClick={handleSubscribe}
        disabled={loading}
        style={{
          width: '100%',
          padding: '14px 0',
          borderRadius: 8,
          background: '#000',
          color: '#fff',
          fontWeight: 600,
          fontSize: 16,
          border: 'none',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'Redirecting to Stripe\u2026' : 'Subscribe'}
      </button>
    </div>
  )
}
