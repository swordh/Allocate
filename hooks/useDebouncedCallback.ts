'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a stable function that delays calling `callback` until `delayMs`
 * has passed since the most recent call — the standard debounce, for
 * anything that would otherwise fire a server round-trip (or worse, an
 * unpaginated collection scan) on every keystroke.
 *
 * The pending timer is cleared on unmount, so a call already in flight when
 * the component goes away (e.g. `router.replace` from a search box) never
 * fires against a component that no longer exists.
 *
 * `callback` is synced into a ref from an effect (never written during
 * render — react-hooks/refs forbids that) so the returned function always
 * invokes the latest closure without needing to be recreated on every
 * render, and without callers having to memoize what they pass in.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return useCallback(
    (...args: Args) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        callbackRef.current(...args)
      }, delayMs)
    },
    [delayMs],
  )
}
