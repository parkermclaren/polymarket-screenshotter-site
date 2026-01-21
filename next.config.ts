import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Puppeteer + chromium in Next needs this to avoid bundling issues
  serverExternalPackages: ['@sparticuz/chromium-min', 'puppeteer', 'puppeteer-core'],
}

export default nextConfig
