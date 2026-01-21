import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Polymarket Screenshotter',
  description: 'Instant 7:8 Polymarket market screenshots.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
