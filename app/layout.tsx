import type { Metadata } from 'next'
import Providers from '@/lib/providers'
import './globals.css'

/**
 * Aktiv Grotesk is a commercial font — not available via Google Fonts.
 * Font files must be placed in public/fonts/ before activating localFont below.
 * Required files:
 *   public/fonts/AktivGrotesk-Light.woff2    (weight: 300)
 *   public/fonts/AktivGrotesk-Regular.woff2  (weight: 400)
 *   public/fonts/AktivGrotesk-Bold.woff2     (weight: 700)
 *   public/fonts/AktivGrotesk-Black.woff2    (weight: 900)
 * Until the files are present the app falls back to system-ui (defined in globals.css).
 *
 * To enable: uncomment the localFont block below and add className={aktivGrotesk.variable}
 * to the <html> element.
 */

export const metadata: Metadata = {
  title:       'Allocate',
  description: 'Film production equipment booking',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
