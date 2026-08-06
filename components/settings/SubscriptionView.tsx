'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPortalSession, createPlanChangeSession } from '@/actions/subscription'
import { getSubStateDisplay, getPlanCardCta } from '@/lib/subscription-state'
import { PLAN_CATALOG, PLAN_ORDER, type PlanId } from '@/lib/plans'
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import type { Subscription, BillingInterval } from '@/types'
import styles from './SubscriptionView.module.css'

interface SubscriptionViewProps {
  subscription: Subscription | null
  companyName: string
  equipmentCount: number
  memberCount: number
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Elapsed fraction of the current billing period, approximated from
 * `currentPeriodEnd` and `interval` — Firestore does not mirror a period
 * *start* field, so the start is inferred as end minus one interval length.
 */
function renewalPct(sub: Subscription): number {
  if (!sub.currentPeriodEnd) return 0
  const end = new Date(sub.currentPeriodEnd).getTime()
  if (Number.isNaN(end)) return 0
  const totalMs = (sub.interval === 'year' ? 365 : 30) * 86_400_000
  const start = end - totalMs
  const elapsed = Date.now() - start
  return Math.min(1, Math.max(0, elapsed / totalMs))
}

export default function SubscriptionView({
  subscription,
  companyName,
  equipmentCount,
  memberCount,
}: SubscriptionViewProps) {
  const router = useRouter()
  const [cycle, setCycle] = useState<BillingInterval>(subscription?.interval ?? 'month')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const display = getSubStateDisplay(subscription, companyName)

  async function goToStripe(result: { url: string } | { error: string }) {
    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoading(false)
    }
  }

  async function handleManage() {
    setLoading(true)
    setError(null)
    await goToStripe(await createPortalSession())
  }

  async function handleNoticeCta() {
    if (display.key === 'NONE') {
      router.push('/subscribe')
      return
    }
    // ADD PAYMENT METHOD / UPDATE CARD / RESUME PLAN all land in the Billing
    // Portal — it already exposes payment-method updates and a "renew" action
    // for subscriptions with cancelAtPeriodEnd set.
    await handleManage()
  }

  async function handlePlanChange(plan: PlanId) {
    setLoading(true)
    setError(null)
    await goToStripe(await createPlanChangeSession(plan, cycle))
  }

  const usage = subscription
    ? [
        {
          label: 'EQUIPMENT',
          value: `${equipmentCount} / ${subscription.limits.equipment}`,
          pct: `${Math.min(100, Math.round((equipmentCount / Math.max(1, subscription.limits.equipment)) * 100))}%`,
        },
        {
          label: 'USERS',
          value: `${memberCount} / ${subscription.limits.users}`,
          pct: `${Math.min(100, Math.round((memberCount / Math.max(1, subscription.limits.users)) * 100))}%`,
        },
        {
          label: 'NEXT RENEWAL',
          value: formatShortDate(subscription.currentPeriodEnd ?? subscription.trialEnd),
          pct: `${Math.round(renewalPct(subscription) * 100)}%`,
        },
      ]
    : []

  return (
    <div className={styles.container}>
      {display.notice && (
        <ErrorBanner
          tone={display.tone}
          action={
            <Button variant="primary" size="sm" onClick={handleNoticeCta} disabled={loading}>
              {display.cta}
            </Button>
          }
        >
          {display.notice}
        </ErrorBanner>
      )}

      {subscription && (
        <div className={styles.currentCard} data-accent={display.accent}>
          <div className={styles.currentMeta}>
            {/* Desktop: eyebrow, then name+pill, then cycle copy stacked
                (unchanged). Mobile: a single baseline row — name, pill, a
                spacer, cycle copy right-aligned, no eyebrow (design line
                260-265 has none). Two renders, CSS picks one — same
                desk/mobile split pattern already used for the cycle chips
                below and throughout TeamSettingsView. */}
            <div className={styles.deskOnly}>
              <span className={styles.eyebrow}>CURRENT PLAN</span>
              <div className={styles.planRow}>
                <span className={styles.planName}>{PLAN_CATALOG[subscription.plan]?.name ?? subscription.plan}</span>
                <Chip size="tag" tone={display.accent} interactive={false}>
                  {display.label}
                </Chip>
              </div>
              <span className={styles.cycleCopy}>{display.cycle}</span>
            </div>
            <div className={`${styles.mobileOnly} ${styles.planRowMobile}`}>
              <span className={styles.planNameMobile}>{PLAN_CATALOG[subscription.plan]?.name ?? subscription.plan}</span>
              <Chip size="tag" tone={display.accent} interactive={false} className={styles.statusPill}>
                {display.label}
              </Chip>
              <span className={styles.cycleCopyMobile}>{display.cycle}</span>
            </div>
          </div>

          {usage.map((u) => (
            <div className={styles.usageCol} key={u.label}>
              <span className={styles.usageLabel}>{u.label}</span>
              <span className={styles.usageValue}>{u.value}</span>
              <span className={styles.meterTrack}>
                <span className={styles.meterFill} data-accent={display.accent} style={{ width: u.pct }} />
              </span>
            </div>
          ))}

          <Button
            variant="secondary"
            size="sm"
            onClick={handleManage}
            disabled={loading}
            className={styles.manageBillingBtn}
          >
            MANAGE BILLING
          </Button>
        </div>
      )}

      <div className={styles.pickerHeader}>
        <span className={styles.pickerHeading}>{display.hasSub ? 'CHANGE PLAN' : 'CHOOSE A PLAN'}</span>
        {/* Desktop: dark-fill active chip. Mobile: white/black solid — matches
            the design's mobile chip() helper, distinct from the desktop one.
            Two renders, CSS picks one (same pattern as TeamSettingsView). */}
        <div className={`${styles.cycleChips} ${styles.deskOnly}`}>
          <Chip size="cycle" active={cycle === 'month'} onClick={() => setCycle('month')} disabled={loading}>
            MONTHLY
          </Chip>
          <Chip size="cycle" active={cycle === 'year'} onClick={() => setCycle('year')} disabled={loading}>
            YEARLY
          </Chip>
        </div>
        <div className={`${styles.cycleChips} ${styles.mobileOnly}`}>
          <Chip
            size="cycle"
            variant="solid"
            active={cycle === 'month'}
            onClick={() => setCycle('month')}
            disabled={loading}
            className={styles.cycleChip}
          >
            MONTHLY
          </Chip>
          <Chip
            size="cycle"
            variant="solid"
            active={cycle === 'year'}
            onClick={() => setCycle('year')}
            disabled={loading}
            className={styles.cycleChip}
          >
            YEARLY
          </Chip>
        </div>
      </div>

      <div className={styles.planGrid}>
        {PLAN_ORDER.map((id) => {
          const p = PLAN_CATALOG[id]
          const isCurrent = display.hasSub && subscription?.plan === id
          const price = cycle === 'month' ? p.priceMonthly : p.priceYearly
          // Desktop spells out "/ month" / "/ year"; mobile abbreviates to
          // "/ MO" / "/ YR" per the design (line 531 of the mobile DCLogic).
          // Two renders, CSS picks one (same deskOnly/mobileOnly pattern
          // used throughout this file).
          const per = cycle === 'month' ? '/ month' : '/ year'
          const perMobile = cycle === 'month' ? '/ MO' : '/ YR'
          const cta = getPlanCardCta(id, subscription)

          return (
            <div key={id} className={styles.planCard} data-current={isCurrent || undefined}>
              {/* Wrapped so mobile can fold name+pill and price+unit into one
                  baseline row (design: name, pill, spacer, price, unit) —
                  desktop keeps the same two stacked rows via
                  .planCardTop's own gap reproducing the old parent gap
                  exactly. See .planCardTop in SubscriptionView.module.css. */}
              <div className={styles.planCardTop}>
                <div className={styles.planCardHeader}>
                  <span className={styles.planCardName}>{p.name}</span>
                  {isCurrent && (
                    <Chip size="tag" tone="accent" interactive={false} className={styles.statusPill}>
                      CURRENT
                    </Chip>
                  )}
                </div>
                <div className={styles.planCardPrice}>
                  <span className={styles.priceValue}>{price.toLocaleString('sv-SE')} kr</span>
                  <span className={`${styles.pricePer} ${styles.deskOnly}`}>{per}</span>
                  <span className={`${styles.pricePer} ${styles.mobileOnly}`}>{perMobile}</span>
                </div>
              </div>
              <div className={styles.featureList}>
                {p.features.map((f) => (
                  <span key={f} className={styles.feature}>
                    — {f}
                  </span>
                ))}
              </div>
              <Button
                variant={isCurrent ? 'secondary-alt' : 'primary'}
                size="md"
                fullWidth
                disabled={loading || isCurrent}
                onClick={() => (display.hasSub ? handlePlanChange(id) : router.push('/subscribe'))}
                className={styles.planCta}
              >
                {cta}
              </Button>
            </div>
          )
        })}
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}

      <p className={styles.prorationCopy}>
        {display.hasSub
          ? 'Plan changes take effect immediately. The difference for the rest of the current period is prorated — an upgrade is charged now, a downgrade becomes credit on your next invoice.'
          : 'You will be taken to Stripe Checkout. Bookings unlock as soon as the payment clears.'}
      </p>
    </div>
  )
}
