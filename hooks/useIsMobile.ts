'use client'

import { useEffect, useState } from 'react'

/** The one breakpoint the design uses, shared with the CSS modules. */
export const MOBILE_QUERY = '(max-width: 768px)'

/**
 * Whether the viewport is below the mobile breakpoint.
 *
 * Starts false and settles after mount, so the server and the first client
 * render agree. Only use it where CSS cannot decide — the booking form moves
 * whole panels into a Sheet on mobile, which is a different container, not a
 * different style. Anything expressible in CSS belongs in the module.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    setIsMobile(mql.matches)

    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
