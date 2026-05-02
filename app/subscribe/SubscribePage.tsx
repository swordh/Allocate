'use client'

import { useState } from 'react'
import { createCheckoutSession } from '@/actions/subscription'
import s from './SubscribePage.module.css'

export default function SubscribePage() {
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubscribe() {
    setLoading(true)
    setError(null)
    const result = await createCheckoutSession(interval)
    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className={s.wrapper}>
      <h1 className={s.heading}>Subscribe</h1>
      <p className={s.subHeading}>Get started with Allocate</p>

      <div className={s.planCard}>
        <span className={s.planBadge}>Starter</span>
        <div className={s.planFeatures}>
          <span>25 equipment items</span>
          <span className={s.featureSep}>·</span>
          <span>10 members</span>
        </div>
      </div>

      <div className={s.sectionLabel}>
        <span>Billing interval</span>
        <div className={s.rule} />
      </div>

      <div className={s.intervalToggle}>
        <button
          className={`${s.intervalBtn} ${interval === 'month' ? s.intervalBtnActive : ''}`}
          onClick={() => setInterval('month')}
        >
          Monthly
        </button>
        <button
          className={`${s.intervalBtn} ${interval === 'year' ? s.intervalBtnActive : ''}`}
          onClick={() => setInterval('year')}
        >
          <span className={s.yearlyLabel}>
            Yearly
            <span className={s.savingsBadge}>Save 20%</span>
          </span>
        </button>
      </div>

      {error && <div className={s.errorBanner}>{error}</div>}

      <button
        className={s.btnSubscribe}
        onClick={handleSubscribe}
        disabled={loading}
      >
        {loading ? 'Redirecting to Stripe…' : 'Subscribe'}
      </button>
    </div>
  )
}
