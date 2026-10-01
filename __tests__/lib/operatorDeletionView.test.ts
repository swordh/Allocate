import { describe, it, expect } from 'vitest'
import {
  isStuckDeletion,
  identityDisplay,
  timeRemaining,
  phaseProgressLabel,
  STRIPE_EFFECT_LABELS,
  STALE_LEASE_MS,
  FAILURE_REASON_LABELS,
  OPERATOR_ACTION_LABELS,
} from '@/lib/operatorDeletionView'
import type { StripeDeletionEffect } from '@/lib/companyDeletionStripe'
import type { CompanyDeletionFailureReason } from '@/types'

const NOW = new Date('2026-09-15T12:00:00.000Z').getTime()

describe('isStuckDeletion', () => {
  it('flags a failed row regardless of heartbeat', () => {
    expect(isStuckDeletion({ state: 'failed', lastHeartbeatAt: null }, NOW)).toBe(true)
    expect(isStuckDeletion({ state: 'failed' }, NOW)).toBe(true)
  })

  it('does not flag executing with a fresh heartbeat', () => {
    const fresh = new Date(NOW - 5 * 60 * 1000).toISOString() // 5 min ago
    expect(isStuckDeletion({ state: 'executing', lastHeartbeatAt: fresh }, NOW)).toBe(false)
  })

  it('flags executing once the heartbeat is older than STALE_LEASE_MS', () => {
    const justUnder = new Date(NOW - (STALE_LEASE_MS - 1000)).toISOString()
    const justOver = new Date(NOW - (STALE_LEASE_MS + 1000)).toISOString()
    expect(isStuckDeletion({ state: 'executing', lastHeartbeatAt: justUnder }, NOW)).toBe(false)
    expect(isStuckDeletion({ state: 'executing', lastHeartbeatAt: justOver }, NOW)).toBe(true)
  })

  it('does not flag executing with no heartbeat yet (just claimed)', () => {
    expect(isStuckDeletion({ state: 'executing', lastHeartbeatAt: undefined }, NOW)).toBe(false)
  })

  it('never flags requested, canceled or completed', () => {
    expect(isStuckDeletion({ state: 'requested', lastHeartbeatAt: null }, NOW)).toBe(false)
    expect(isStuckDeletion({ state: 'canceled', lastHeartbeatAt: null }, NOW)).toBe(false)
    expect(isStuckDeletion({ state: 'completed', lastHeartbeatAt: null }, NOW)).toBe(false)
  })
})

describe('identityDisplay', () => {
  it('renders null as redacted, not as the same "—" as never-happened', () => {
    expect(identityDisplay(null)).toEqual({ kind: 'redacted' })
  })

  it('renders undefined as never-happened', () => {
    expect(identityDisplay(undefined)).toEqual({ kind: 'never' })
  })

  it('renders a real string as known', () => {
    expect(identityDisplay('Jane Admin')).toEqual({ kind: 'known', text: 'Jane Admin' })
  })

  it('redacted and never are distinct kinds', () => {
    expect(identityDisplay(null).kind).not.toBe(identityDisplay(undefined).kind)
  })
})

describe('timeRemaining', () => {
  it('reports days and hours left, rounded down', () => {
    const scheduledFor = new Date(NOW + 2 * 24 * 60 * 60 * 1000 + 59 * 60 * 1000).toISOString() // 2d 0h59m
    const result = timeRemaining(scheduledFor, NOW)
    expect(result.expired).toBe(false)
    expect(result.label).toBe('2d left') // must not round up to "2d 1h" or "3d"
  })

  it('reports hours only under a day', () => {
    const scheduledFor = new Date(NOW + 5 * 60 * 60 * 1000).toISOString()
    expect(timeRemaining(scheduledFor, NOW).label).toBe('5h left')
  })

  it('reports "less than 1h" rather than rounding up to 1h', () => {
    const scheduledFor = new Date(NOW + 30 * 60 * 1000).toISOString()
    expect(timeRemaining(scheduledFor, NOW).label).toBe('Less than 1h left')
  })

  it('reports the window as closed once the instant has passed', () => {
    const scheduledFor = new Date(NOW - 1000).toISOString()
    const result = timeRemaining(scheduledFor, NOW)
    expect(result.expired).toBe(true)
    expect(result.label).toBe('Window closed')
  })

  it('degrades honestly on an unparsable date instead of throwing', () => {
    const result = timeRemaining('not-a-date', NOW)
    expect(result.expired).toBe(true)
    expect(result.label).toBe('Unknown')
  })
})

describe('phaseProgressLabel', () => {
  it('renders "not started" for no phase at all', () => {
    expect(phaseProgressLabel(null)).toBe('Not started')
    expect(phaseProgressLabel(undefined)).toBe('Not started')
  })

  it('renders position and name for a known phase', () => {
    expect(phaseProgressLabel('members')).toBe('Phase 3 of 6 — Members')
  })

  it('renders the last phase correctly', () => {
    expect(phaseProgressLabel('finalize')).toBe('Phase 6 of 6 — Finalize')
  })
})

describe('STRIPE_EFFECT_LABELS', () => {
  const allEffects: StripeDeletionEffect[] = [
    'applied',
    'no_subscription',
    'already_canceled',
    'resumed_unpaid',
    'failed',
  ]

  it('has a label for every StripeDeletionEffect value', () => {
    for (const effect of allEffects) {
      expect(STRIPE_EFFECT_LABELS[effect]).toBeDefined()
      expect(STRIPE_EFFECT_LABELS[effect].label.length).toBeGreaterThan(0)
    }
  })

  it('never renders resumed_unpaid as a plain success — the whole reason the value exists', () => {
    expect(STRIPE_EFFECT_LABELS.resumed_unpaid.tone).toBe('danger')
    expect(STRIPE_EFFECT_LABELS.resumed_unpaid.label.toLowerCase()).toContain('unpaid')
  })

  it('only "applied" gets the success tone', () => {
    for (const effect of allEffects) {
      if (effect === 'applied') {
        expect(STRIPE_EFFECT_LABELS[effect].tone).toBe('accent')
      } else {
        expect(STRIPE_EFFECT_LABELS[effect].tone).not.toBe('accent')
      }
    }
  })
})

describe('FAILURE_REASON_LABELS', () => {
  const allReasons: CompanyDeletionFailureReason[] = ['attempts_exhausted', 'no_progress', 'operator']

  it('has a non-empty label for every CompanyDeletionFailureReason value', () => {
    for (const reason of allReasons) {
      expect(FAILURE_REASON_LABELS[reason]).toBeDefined()
      expect(FAILURE_REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })
})

describe('OPERATOR_ACTION_LABELS', () => {
  it('has a readable label for every action actions/operatorCompanyDeletion.ts writes', () => {
    for (const action of ['cancel', 'request', 'requeue', 'mark_failed']) {
      expect(OPERATOR_ACTION_LABELS[action]).toBeDefined()
      expect(OPERATOR_ACTION_LABELS[action].length).toBeGreaterThan(0)
    }
  })

  it('falls back to undefined for an unknown action — callers must handle it with ?? action', () => {
    expect(OPERATOR_ACTION_LABELS['some_future_action']).toBeUndefined()
  })
})
