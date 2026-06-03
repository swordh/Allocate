import type { Metadata } from 'next'
import localFont from 'next/font/local'
import Providers from '@/lib/providers'
import './globals.css'

const generalSans = localFont({
  src: [
    {
      path: '../public/fonts/GeneralSans-Variable.woff2',
      style: 'normal',
    },
    {
      path: '../public/fonts/GeneralSans-VariableItalic.woff2',
      style: 'italic',
    },
  ],
  variable: '--font-sans',
  display: 'swap',
})

const ENV_LABELS: Record<string, string> = { dev: 'Dev', alpha: 'Alpha', beta: 'Beta' }
const envLabel = ENV_LABELS[process.env.NEXT_PUBLIC_APP_ENV ?? '']

export const metadata: Metadata = {
  title:       envLabel ? `Allocate (${envLabel})` : 'Allocate',
  description: 'Film production equipment booking',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={generalSans.variable}>
      <head>
        <link
          rel="preload"
          href="/fonts/material-symbols-outlined.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
