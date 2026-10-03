/**
 * lib/equipmentLimitBanner.ts — when the app shell warns an admin that the
 * company holds more equipment items than its plan includes (#284).
 */

import { describe, it, expect } from 'vitest'
import { shouldShowEquipmentLimitBanner, shouldReadEquipmentCount } from '@/lib/equipmentLimitBanner'

const base = { role: 'admin' as const, hasFullAccess: true, count: 30, limit: 25 }

describe('shouldShowEquipmentLimitBanner', () => {
  it('shows for an admin over the limit', () => {
    expect(shouldShowEquipmentLimitBanner(base)).toBe(true)
  })

  it('shows one item over', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, count: 26 })).toBe(true)
  })

  it('hides exactly at the limit', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, count: 25 })).toBe(false)
  })

  it('hides under the limit', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, count: 3 })).toBe(false)
  })

  it('hides for crew even when over the limit', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, role: 'crew' })).toBe(false)
  })

  it('hides when there is no active plan (NoPlanBanner covers that)', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, hasFullAccess: false })).toBe(false)
  })

  it('hides when the counter was not read or the limit is unknown', () => {
    expect(shouldShowEquipmentLimitBanner({ ...base, count: null })).toBe(false)
    expect(shouldShowEquipmentLimitBanner({ ...base, limit: undefined })).toBe(false)
  })
})

describe('shouldReadEquipmentCount', () => {
  it('reads only for an admin with an active plan', () => {
    expect(shouldReadEquipmentCount('admin', true)).toBe(true)
    expect(shouldReadEquipmentCount('crew', true)).toBe(false)
    expect(shouldReadEquipmentCount('admin', false)).toBe(false)
  })
})
