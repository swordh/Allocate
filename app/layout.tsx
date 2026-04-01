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
    <html lang="en" className={generalSans.variable}>
      <head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,300,0,0" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
