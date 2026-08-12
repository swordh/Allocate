import type { ReactElement } from 'react'
import { createElement, Fragment } from 'react'

/**
 * Icon geometry, drawn against a 24x24 box with round caps and joins.
 *
 * Every path is stroke-only — no `fill`, no `stroke` and no colour here. The
 * <Icon> wrapper owns those so the design invariant (18px, stroke-width 1.8,
 * currentColor) holds at every call site. See Icon.tsx.
 *
 * Chevrons and arrows are NOT in this set: the design uses text glyphs for
 * those. Use <Glyph> instead.
 */
export type IconName =
  | 'notifications'
  | 'help'
  | 'menu'
  | 'close'
  | 'calendar'
  | 'construction'
  | 'settings'
  | 'list'
  | 'crate'
  | 'bug'
  | 'lightbulb'
  | 'support-agent'
  | 'check-circle'
  | 'ticket'
  | 'schedule'
  | 'person'
  | 'inventory'
  | 'delete'
  | 'add'
  | 'external-link'
  | 'search'
  | 'eye'
  | 'note'

const p = (d: string, key?: string) => createElement('path', { d, key })
const c = (cx: number, cy: number, r: number, key?: string) =>
  createElement('circle', { cx, cy, r, key })
const g = (...children: ReactElement[]) => createElement(Fragment, null, ...children)

export const ICON_PATHS: Record<IconName, ReactElement> = {
  notifications: g(
    p('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'bell'),
    p('M13.73 21a2 2 0 0 1-3.46 0', 'clapper'),
  ),

  help: g(
    c(12, 12, 10, 'ring'),
    p('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'hook'),
    p('M12 17h.01', 'dot'),
  ),

  menu: g(p('M3 6h18', 'a'), p('M3 12h18', 'b'), p('M3 18h18', 'c')),

  close: g(p('M18 6 6 18', 'a'), p('M6 6l12 12', 'b')),

  calendar: g(
    createElement('rect', { x: 3, y: 5, width: 18, height: 16, key: 'box' }),
    p('M16 3v4', 'r'),
    p('M8 3v4', 'l'),
    p('M3 11h18', 'rule'),
  ),

  construction: g(
    p('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'wrench'),
  ),

  settings: g(
    c(12, 12, 3, 'hub'),
    p('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', 'cog'),
  ),

  /** Three descending horizontal rules. Used for BOOKINGS in the mobile nav
   * sheet — distinct from the calendar glyph used elsewhere for bookings. */
  list: g(p('M4 7h16', 'a'), p('M4 12h16', 'b'), p('M4 17h10', 'c')),

  /** Open crate: rounded rect with a lid rule. Used for EQUIPMENT in the
   * mobile nav sheet — distinct from the wrench glyph used elsewhere. */
  crate: g(
    createElement('rect', { x: 4, y: 5, width: 16, height: 15, rx: 1.5, key: 'box' }),
    p('M4 9.5h16', 'lid'),
  ),

  bug: g(
    createElement('rect', { x: 8, y: 6, width: 8, height: 14, rx: 4, key: 'body' }),
    p('M19 7l-3 2', 'ar'),
    p('M5 7l3 2', 'al'),
    p('M19 13h-3', 'mr'),
    p('M8 13H5', 'ml'),
    p('M19 19l-3-2', 'br'),
    p('M5 19l3-2', 'bl'),
    p('M9.5 6a2.5 2.5 0 0 1 5 0', 'head'),
  ),

  lightbulb: g(
    p('M9 18h6', 'base'),
    p('M10 21h4', 'foot'),
    p('M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v1h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z', 'glass'),
  ),

  'support-agent': g(
    p('M3 17v-5a9 9 0 0 1 18 0v5', 'band'),
    p('M21 16a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z', 'right'),
    p('M3 16a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z', 'left'),
    p('M18 18v1a3 3 0 0 1-3 3h-3', 'mic'),
  ),

  'check-circle': g(c(12, 12, 10, 'ring'), p('m8 12 3 3 5-6', 'tick')),

  ticket: g(
    p('M4 6h16a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.5a2.5 2.5 0 0 0 0-5V7a1 1 0 0 1 1-1z', 'stub'),
    p('M14 7v1.5', 'p1'),
    p('M14 11.5v1', 'p2'),
    p('M14 15.5V17', 'p3'),
  ),

  schedule: g(c(12, 12, 9, 'face'), p('M12 7v5l3 2', 'hands')),

  person: g(c(12, 8, 4, 'head'), p('M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1', 'shoulders')),

  inventory: g(
    p('M3 7l9-4 9 4v10l-9 4-9-4z', 'box'),
    p('M3 7l9 4 9-4', 'lid'),
    p('M12 11v10', 'seam'),
  ),

  delete: g(
    p('M4 7h16', 'bar'),
    p('M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'lid'),
    p('M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'can'),
    p('M10 11v6', 'l'),
    p('M14 11v6', 'r'),
  ),

  add: g(p('M12 5v14', 'v'), p('M5 12h14', 'h')),

  'external-link': g(
    p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'frame'),
    p('M15 3h6v6', 'corner'),
    p('M10 14 21 3', 'arrow'),
  ),

  search: g(c(11, 11, 7, 'lens'), p('M20 20l-4-4', 'handle')),

  // The SHOW CANCELLED filter in the mobile nav sheet (screen 08 Mobil).
  eye: g(p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'outline'), c(12, 12, 3, 'pupil')),

  // The notes drawer trigger on the mobile booking form (screen 09 Mobil).
  note: g(
    p('M6 4h9l3 3v13H6z', 'page'),
    p('M15 4v3h3', 'fold'),
    p('M9 12h6M9 16h6', 'lines'),
  ),
}
