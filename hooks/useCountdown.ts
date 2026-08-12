'use client'

import { useEffect, useState } from 'react'

function computeSecondsLeft(deadlineMs: number | null): number {
  if (deadlineMs === null) return 0
  return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
}

function formatLabel(secondsLeft: number): string {
  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Counts down to `deadlineMs` in whole seconds, one `setInterval(1000)`.
 * Label format is `M:SS` with an unpadded minute (design's "0:18", not
 * "00:18"). Returns zero/"0:00" when the deadline is null or already past,
 * and clears its interval on unmount and once it reaches zero.
 *
 * `secondsLeft` is recomputed from `deadlineMs` and `Date.now()` on every
 * render (driven by an internal tick counter) rather than mirrored into its
 * own state, so a changing `deadlineMs` never needs a synchronous setState
 * inside the effect.
 */
export function useCountdown(deadlineMs: number | null): { secondsLeft: number; label: string } {
  const [, setTick] = useState(0)
  const secondsLeft = computeSecondsLeft(deadlineMs)

  useEffect(() => {
    if (deadlineMs === null || computeSecondsLeft(deadlineMs) === 0) return

    const interval = setInterval(() => {
      setTick((prev) => prev + 1)
      if (computeSecondsLeft(deadlineMs) === 0) clearInterval(interval)
    }, 1000)

    return () => clearInterval(interval)
  }, [deadlineMs])

  return { secondsLeft, label: formatLabel(secondsLeft) }
}
