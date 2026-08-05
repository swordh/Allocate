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

// Display face: large page headings, numbers, table values. See public/fonts/README.md.
const archivo = localFont({
  src: '../public/fonts/Archivo-Variable.woff2',
  weight: '400 800',
  style: 'normal',
  variable: '--font-display',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
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
    <html lang="en" className={`${generalSans.variable} ${archivo.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
