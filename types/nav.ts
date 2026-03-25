export type LogoContext =
  | { type: 'list'; bookingsToday: number; totalToday: number }
  | { type: 'week'; weekNumber: number; month: string; year: number }
  | { type: 'month'; month: string; year: number }
  | { type: '4weeks'; startWeek: number; endWeek: number; year: number }
  | { type: 'equipment' }
  | { type: 'settings' }
