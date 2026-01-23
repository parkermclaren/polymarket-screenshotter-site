import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Puppeteer + chromium in Next needs this to avoid bundling issues
  serverExternalPackages: [
    '@sparticuz/chromium-min',
    'puppeteer',
    'puppeteer-core',
    'puppeteer-extra',
    'puppeteer-extra-plugin-stealth',
    'clone-deep',
  ],
}

export default nextConfig
