import type { Metadata } from 'next'
import localFont from 'next/font/local'
import Providers from '@/lib/providers'
import './globals.css'

/**
 * Aktiv Grotesk is a commercial font — not available via Google Fonts.
 * Font files must be placed in public/fonts/ before this loads correctly.
 * Required files:
 *   public/fonts/AktivGrotesk-Light.woff2    (weight: 300)
 *   public/fonts/AktivGrotesk-Regular.woff2  (weight: 400)
 *   public/fonts/AktivGrotesk-Bold.woff2     (weight: 700)
 *   public/fonts/AktivGrotesk-Black.woff2    (weight: 900)
 * Until the files are present, the font will fall back to system-ui in globals.css.
 */
const aktivGrotesk = localFont({
  src: [
    { path: '../public/fonts/AktivGrotesk-Light.woff2',   weight: '300', style: 'normal' },
    { path: '../public/fonts/AktivGrotesk-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/AktivGrotesk-Bold.woff2',    weight: '700', style: 'normal' },
    { path: '../public/fonts/AktivGrotesk-Black.woff2',   weight: '900', style: 'normal' },
  ],
  variable: '--font-aktiv',
  display:  'swap',
  fallback: ['system-ui', 'sans-serif'],
})

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
    <html lang="en" className={aktivGrotesk.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
