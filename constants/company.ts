export type TimeSlotOption = 1 | 5 | 10 | 15 | 60 | -1  // -1 = Full Day
export const TIME_SLOT_OPTIONS: TimeSlotOption[] = [1, 5, 10, 15, 60, -1]
export const TIME_SLOT_LABELS: Record<number, string> = {
  1:   '1 min',
  5:   '5 min',
  10:  '10 min',
  15:  '15 min',
  60:  '1 hour',
  [-1]: 'Full Day',
}

export type BookingViewOption = 'list' | 'week' | 'month' | '4weeks'
export const BOOKING_VIEW_OPTIONS: BookingViewOption[] = ['list', 'week', 'month', '4weeks']
export const BOOKING_VIEW_LABELS: Record<BookingViewOption, string> = {
  list:     'List',
  week:     'Week',
  month:    'Month',
  '4weeks': '4 Weeks',
}
export const BOOKING_VIEW_PATHS: Record<BookingViewOption, string> = {
  list:     '/bookings/list',
  week:     '/bookings/week',
  month:    '/bookings/month',
  '4weeks': '/bookings/4weeks',
}

export const DEFAULT_COMPANY_PREFERENCES = {
  bookingTimeSlotMinutes: 15,
  autoCheckout: false,
  autoCheckin: false,
  timezone: 'UTC',
}

export const TIMEZONE_OPTIONS: { label: string; value: string }[] = [
  { label: 'UTC',                    value: 'UTC' },
  { label: 'Europe/London',          value: 'Europe/London' },
  { label: 'Europe/Stockholm',       value: 'Europe/Stockholm' },
  { label: 'Europe/Berlin',          value: 'Europe/Berlin' },
  { label: 'Europe/Helsinki',        value: 'Europe/Helsinki' },
  { label: 'Europe/Moscow',          value: 'Europe/Moscow' },
  { label: 'Africa/Cairo',           value: 'Africa/Cairo' },
  { label: 'Africa/Lagos',           value: 'Africa/Lagos' },
  { label: 'Africa/Nairobi',         value: 'Africa/Nairobi' },
  { label: 'Africa/Johannesburg',    value: 'Africa/Johannesburg' },
  { label: 'Asia/Dubai',             value: 'Asia/Dubai' },
  { label: 'Asia/Kolkata',           value: 'Asia/Kolkata' },
  { label: 'Asia/Bangkok',           value: 'Asia/Bangkok' },
  { label: 'Asia/Singapore',         value: 'Asia/Singapore' },
  { label: 'Asia/Tokyo',             value: 'Asia/Tokyo' },
  { label: 'Asia/Seoul',             value: 'Asia/Seoul' },
  { label: 'Asia/Shanghai',          value: 'Asia/Shanghai' },
  { label: 'Australia/Sydney',       value: 'Australia/Sydney' },
  { label: 'Pacific/Auckland',       value: 'Pacific/Auckland' },
  { label: 'America/New_York',       value: 'America/New_York' },
  { label: 'America/Chicago',        value: 'America/Chicago' },
  { label: 'America/Denver',         value: 'America/Denver' },
  { label: 'America/Los_Angeles',    value: 'America/Los_Angeles' },
  { label: 'America/Sao_Paulo',      value: 'America/Sao_Paulo' },
  { label: 'America/Mexico_City',    value: 'America/Mexico_City' },
  { label: 'Pacific/Honolulu',       value: 'Pacific/Honolulu' },
]
