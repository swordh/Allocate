'use client'

import { useState } from 'react'
import type { Plan } from '@/types'
import { createCheckoutSession } from '@/actions/subscription'
import { PLANS } from '@/lib/plans'

export default function SubscribePage() {
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [selectedPlan, setSelectedPlan] = useState<Plan>('small')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubscribe() {
    setLoading(true)
    setError(null)
    const result = await createCheckoutSession(interval, selectedPlan)
    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoading(false)
    }
  }

  const planList: Plan[] = ['basic', 'small', 'mid', 'large']
  const price = interval === 'month' ? PLANS[selectedPlan].monthlyPrice : PLANS[selectedPlan].yearlyPrice

  return (
    <div style={{ maxWidth: 600, margin: '80px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Subscribe to Allocate</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Choose a plan and billing interval to get started.</p>

      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Plans</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
          {planList.map((plan) => (
            <button
              key={plan}
              onClick={() => setSelectedPlan(plan)}
              style={{
                padding: '16px 12px',
                borderRadius: 8,
                border: selectedPlan === plan ? '2px solid #000' : '1px solid #ddd',
                background: 'white',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div style={{ fontWeight: selectedPlan === plan ? 600 : 500, marginBottom: 4 }}>
                {PLANS[plan].name}
              </div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                {PLANS[plan].limits.equipment} equipment
              </div>
              <div style={{ fontSize: 12, color: '#666' }}>
                {PLANS[plan].limits.users} users
              </div>
            </button>
          ))}
        </div>
      </div>

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

      <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 8, textAlign: 'center' }}>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 4 }}>
          {PLANS[selectedPlan].name} • {interval === 'month' ? 'Monthly' : 'Yearly'}
        </p>
        <p style={{ fontSize: 24, fontWeight: 600 }}>
          {price} SEK {interval === 'month' ? '/mo' : '/year'}
        </p>
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
