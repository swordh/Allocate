'use client'

import { useState } from 'react'
import { createCheckoutSession } from '@/actions/subscription'
import { PLAN_CATALOG, PLAN_ORDER, type PlanId } from '@/lib/plans'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { BillingInterval } from '@/types'
import s from './SubscribePage.module.css'

interface SubscribePageProps {
  companyName: string
}

export default function SubscribePage({ companyName }: SubscribePageProps) {
  const [cycle, setCycle] = useState<BillingInterval>('month')
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSelect(plan: PlanId) {
    setLoadingPlan(plan)
    setError(null)
    const result = await createCheckoutSession(cycle, plan)
    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoadingPlan(null)
    }
  }

  return (
    <div className={s.wrapper}>
      <span className={s.logo}>ALLOCATE</span>

      <div className={s.intro}>
        <span className={s.eyebrow}>NO ACTIVE SUBSCRIPTION</span>
        <h1 className={s.heading}>Choose a plan</h1>
        <p className={s.subheading}>
          {companyName || 'Your company'} needs an active plan to create bookings. Pick a plan below — you can
          change or cancel it any time from Settings.
        </p>
      </div>

      <div className={s.cycleToggle}>
        <Chip
          size="cycle"
          variant="solid"
          active={cycle === 'month'}
          onClick={() => setCycle('month')}
          disabled={loadingPlan !== null}
        >
          MONTHLY
        </Chip>
        <Chip
          size="cycle"
          variant="solid"
          active={cycle === 'year'}
          onClick={() => setCycle('year')}
          disabled={loadingPlan !== null}
        >
          YEARLY — 2 MONTHS FREE
        </Chip>
      </div>

      <div className={s.planGrid}>
        {PLAN_ORDER.map((id) => {
          const p = PLAN_CATALOG[id]
          const price = cycle === 'month' ? p.priceMonthly : p.priceYearly
          const per = cycle === 'month' ? '/ month' : '/ year'
          const recommended = id === 'basic'

          return (
            <div key={id} className={s.planCard} data-recommended={recommended || undefined}>
              <div className={s.planCardHeader}>
                <span className={s.planName}>{p.name}</span>
                {recommended && (
                  <Chip size="tag" tone="accent" interactive={false}>
                    RECOMMENDED
                  </Chip>
                )}
              </div>
              <div className={s.planPrice}>
                <span className={s.priceValue}>{price.toLocaleString('sv-SE')} kr</span>
                <span className={s.pricePer}>{per}</span>
              </div>
              <div className={s.featureList}>
                {p.features.map((f) => (
                  <span key={f} className={s.feature}>
                    — {f}
                  </span>
                ))}
              </div>
              <Button
                variant={recommended ? 'primary' : 'secondary'}
                size="md"
                fullWidth
                disabled={loadingPlan !== null}
                onClick={() => handleSelect(id)}
              >
                {loadingPlan === id ? 'REDIRECTING…' : `SELECT ${p.name.toUpperCase()}`}
              </Button>
            </div>
          )
        })}
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
    </div>
  )
}
