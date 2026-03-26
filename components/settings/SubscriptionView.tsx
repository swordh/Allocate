'use client'

import { useState } from 'react'
import { createPortalSession } from '@/actions/subscription'
import type { Subscription } from '@/types'
import styles from './SubscriptionView.module.css'

interface SubscriptionViewProps {
  subscription: Subscription | null
}

const PLAN_LABELS: Record<string, string> = {
  basic:      'Basic',
  small:      'Small',
  mid:        'Mid',
  large:      'Large',
  enterprise: 'Enterprise',
}

const STATUS_LABELS: Record<string, string> = {
  trialing:  'Trial',
  active:    'Active',
  past_due:  'Past Due',
  canceled:  'Canceled',
}

export default function SubscriptionView({ subscription }: SubscriptionViewProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleManage() {
    setLoading(true)
    setError(null)

    const result = await createPortalSession()

    if ('url' in result) {
      window.location.href = result.url
    } else {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.heading}>Settings</div>
      <div className={styles.subHeading}>Subscription</div>

      {subscription === null ? (
        <div className={styles.noSubscription}>
          <p className={styles.noSubText}>No active subscription.</p>
        </div>
      ) : (
        <>
          {/* Current plan block */}
          <div className={styles.currentPlanBlock}>
            <span className={styles.planBadge}>
              {PLAN_LABELS[subscription.plan] ?? subscription.plan}
            </span>

            <div className={styles.planStatus}>
              <span className={`${styles.statusDot} ${styles[`status_${subscription.status}`]}`} />
              <span className={styles.statusLabel}>
                {STATUS_LABELS[subscription.status] ?? subscription.status}
              </span>
            </div>

            <div className={styles.planDetails}>
              <span>{subscription.limits.equipment} equipment items</span>
              <span className={styles.detailSep}>·</span>
              <span>{subscription.limits.users} members</span>
            </div>

            {subscription.status === 'trialing' && subscription.trialEnd && (
              <div className={styles.trialNotice}>
                Trial ends {formatDate(subscription.trialEnd)}
              </div>
            )}

            {subscription.status !== 'trialing' && subscription.currentPeriodEnd && (
              <div className={styles.renewalNotice}>
                {subscription.cancelAtPeriodEnd
                  ? `Cancels ${formatDate(subscription.currentPeriodEnd)}`
                  : `Renews ${formatDate(subscription.currentPeriodEnd)}`}
              </div>
            )}
          </div>

          {/* Error banner */}
          {error && (
            <div className={styles.errorBanner}>
              {error}
            </div>
          )}

          {/* Manage billing */}
          <button
            className={styles.btnManage}
            onClick={handleManage}
            disabled={loading}
            type="button"
          >
            {loading ? 'Redirecting…' : 'Manage Subscription'}
          </button>
        </>
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
