/**
 * What clicking a segment of an OPEN | BLOCKED control should do.
 *
 * Returns the value to confirm (true = blocked), or null when the clicked
 * segment is already the active one — a no-op. Kept out of the component so
 * it can be unit-tested (the suite has no DOM environment).
 */
export function segmentTarget(currentlyBlocked: boolean, clicked: 'open' | 'blocked'): boolean | null {
  const target = clicked === 'blocked'
  return target === currentlyBlocked ? null : target
}
