'use client'

import { useState } from 'react'
import { createCheckoutSession } from '@/actions/subscription'
import { PLAN_CATALOG, PLAN_ORDER, type PlanId } from '@/lib/plans'
import s from './SubscribePage.module.css'

export default function SubscribePage() {
  const [plan, setPlan] = useState<PlanId>('starter')
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubscribe() {
    setLoading(true)
    setError(null)
    const result = await createCheckoutSession(interval, plan)
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

      <div className={s.sectionLabel}>
        <span>Plan</span>
        <div className={s.rule} />
      </div>

      <div className={s.planGrid}>
        {PLAN_ORDER.map((id) => {
          const p = PLAN_CATALOG[id]
          const price = interval === 'month' ? p.priceMonthly : p.priceYearly
          return (
            <button
              key={id}
              type="button"
              className={`${s.planOption} ${plan === id ? s.planOptionActive : ''}`}
              onClick={() => setPlan(id)}
              aria-pressed={plan === id}
            >
              <div className={s.planOptionHeader}>
                <span className={s.planName}>{p.name}</span>
                <span className={s.planPrice}>
                  {price} kr
                  <span className={s.planPriceUnit}>/{interval === 'month' ? 'mo' : 'yr'}</span>
                </span>
              </div>
              <div className={s.planFeatures}>
                <span>{p.equipment} equipment items</span>
                <span className={s.featureSep}>·</span>
                <span>{p.users} members</span>
              </div>
            </button>
          )
        })}
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
