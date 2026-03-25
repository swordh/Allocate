import BookingsSecondaryNav from '@/components/nav/BookingsSecondaryNav'

/**
 * Bookings layout — Server Component.
 * Shared across all four booking views: list, week, month, 4weeks.
 * Renders the secondary sub-nav (List | Week | Month | 4 Weeks).
 */
export default function BookingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BookingsSecondaryNav />
      {children}
    </>
  )
}
