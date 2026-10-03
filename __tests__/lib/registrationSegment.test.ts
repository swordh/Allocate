import { describe, it, expect } from 'vitest'
import { segmentTarget } from '@/lib/registrationSegment'

describe('segmentTarget', () => {
  it('open switch: clicking BLOCKED targets blocked', () => {
    expect(segmentTarget(false, 'blocked')).toBe(true)
  })

  it('blocked switch: clicking OPEN targets open', () => {
    expect(segmentTarget(true, 'open')).toBe(false)
  })

  it('clicking the already-active segment is a no-op', () => {
    expect(segmentTarget(false, 'open')).toBeNull()
    expect(segmentTarget(true, 'blocked')).toBeNull()
  })
})
