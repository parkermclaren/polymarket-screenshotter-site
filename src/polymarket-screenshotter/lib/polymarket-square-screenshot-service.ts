import puppeteer, { Browser, Page } from 'puppeteer'
import { applyChartWatermark, type ChartWatermarkMode } from './rules/chart'
import { removeHowItWorks, removeHowItWorksSecondPass } from './rules/how-it-works'
import { styleVolumeRow } from './rules/volume-row'
import { styleBuyButtons } from './rules/buy-buttons'
import { styleOutcomeLegend } from './rules/outcome-legend'
import { cropToEventChart, measureEventChartHeight } from './rules/event-chart-crop'
import { filterChartToSingleOutcome } from './rules/single-outcome-filter'

// Square aspect ratio (1:1) for single image posts
// This means for a given width, height = width
const SQUARE_ASPECT_RATIO = 1

interface ScreenshotOptions {
  width?: number
  height?: number
  deviceScaleFactor?: number
  timeRange?: '1h' | '6h' | '1d' | '1w' | '1m' | 'max' // Chart time range, defaults to '1d'
  chartWatermark?: ChartWatermarkMode | boolean // Watermark mode; boolean true maps to 'wordmark'
  debugLayout?: boolean
  showPotentialPayout?: boolean // Show potential payout below buy buttons (e.g., "$150 → $197")
  payoutInvestment?: number // Investment amount for payout calculation (defaults to $150)
}

export interface ScreenshotResult {
  success: boolean
  screenshot?: Buffer
  fileName?: string
  error?: string
  marketTitle?: string
  url?: string
}

type ClipRect = { x: number; y: number; width: number; height: number }

/**
 * Extracts the slug/path from a Polymarket URL
 * Handles both /event/ and /market/ URLs
 *
 * For nested market URLs like /event/presidential-election-winner-2028/will-jd-vance-win...,
 * returns both the event slug and the nested market slug.
 */
function parsePolymarketUrl(url: string): {
  valid: boolean
  cleanUrl: string
  slug: string
  nestedMarketSlug?: string  // Present when URL points to a specific outcome within an event
} {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes('polymarket.com')) {
      return { valid: false, cleanUrl: '', slug: '' }
    }

    const pathMatch = parsed.pathname.match(/^\/(event|market)\/(.+)/)
    if (!pathMatch) {
      return { valid: false, cleanUrl: '', slug: '' }
    }

    const pathParts = pathMatch[2].split('/').filter(Boolean)
    const slug = pathParts[0] // Main event/market slug
    const nestedMarketSlug = pathParts[1] // Specific outcome slug (if present)

    // For nested markets, use the full URL to navigate to the specific outcome
    // For event-only URLs, use the clean event URL
    const cleanUrl = nestedMarketSlug
      ? `https://polymarket.com/event/${slug}/${nestedMarketSlug}`
      : `https://polymarket.com/event/${slug}`

    return { valid: true, cleanUrl, slug, nestedMarketSlug }
  } catch {
    return { valid: false, cleanUrl: '', slug: '' }
  }
}

export class PolymarketSquareScreenshotService {
  private browser: Browser | null = null

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Puppeteer for Polymarket square screenshots...')

    const isServerless = process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL || process.env.VERCEL_ENV
    const executablePath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim()

    if (isServerless) {
      console.log('🔧 Detected serverless environment, using @sparticuz/chromium')

      try {
        const chromium = (await import('@sparticuz/chromium-min')).default
        const chromiumPath = await chromium.executablePath(
          `https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar`
        )
        console.log('📍 Chromium executable path:', chromiumPath)

        this.browser = await puppeteer.launch({
          args: chromium.args,
          defaultViewport: null,
          executablePath: chromiumPath,
          headless: 'shell',
        })
      } catch (error) {
        console.error('❌ Square screenshot service initialization failed:', error)
        throw new Error(`Square screenshot service initialization failed in serverless environment: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    } else {
      console.log('🖥️ Using local Puppeteer installation')
      this.browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        ...(executablePath ? { executablePath } : {}),
        args: [
          '--lang=en-US',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
        timeout: 30000
      })
    }

    console.log('✅ Browser initialized for Polymarket square screenshots')
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      console.log('🧹 Polymarket square screenshot browser closed')
    }
  }

  /**
   * Wait for the Polymarket page to fully load
   * Waits for the chart and key UI elements to appear
   */
  private async waitForPageLoad(page: Page): Promise<void> {
    // Wait for the main content to load (Polymarket uses <main> but be defensive)
    await page.waitForSelector('main, [role="main"]', { timeout: 20000 })
    
    // Wait for the chart canvas or SVG to appear (the main chart)
    try {
      await page.waitForSelector('canvas, svg[class*="chart"], [class*="recharts"]', { timeout: 15000 })
    } catch {
      console.log('⚠️ Chart element not found, continuing anyway')
    }

    // Wait for network to settle
    try {
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 3000 })
    } catch {
      // If network doesn't settle (e.g. persistent polling), just continue
      console.log('⚠️ Network did not settle completely, continuing...')
    }
  }

  /**
   * Ensure web fonts have finished loading before measuring/cropping.
   * Font swaps can shift layout on slower environments (e.g. prod containers).
   */
  private async waitForFonts(page: Page): Promise<void> {
    try {
      await page.waitForFunction(
        () => {
          const fonts = (document as unknown as { fonts?: { status?: string } }).fonts
          return !fonts || fonts.status === 'loaded'
        },
        { timeout: 5000 }
      )
      // Allow a couple of frames for layout to settle after fonts load.
      await page.evaluate(
        () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
    } catch {
      console.log('⚠️ Font loading check timed out, continuing...')
    }
  }

  /**
   * Compute a 1:1 crop region that guarantees the Buy Yes/Buy No buttons are included.
   * We do this by finding `.trading-button-text` elements and cropping from the title down
   * through the bottom of the Buy buttons.
   *
   * Returns a clip rect in page screenshot coordinates.
   */
  private async computeBuyButtonsAnchoredClip(page: Page, width: number, height: number): Promise<ClipRect | null> {
    try {
      const rect = await page.evaluate((w, h) => {
        const findButton = (needle: string): HTMLElement | null => {
          const texts = Array.from(document.querySelectorAll('.trading-button-text')) as HTMLElement[]
          const match = texts.find(t => (t.textContent || '').trim().toLowerCase().startsWith(needle))
          const btn = match?.closest('button') as HTMLElement | null
          return btn
        }

        const yesBtn = findButton('buy yes')
        const noBtn = findButton('buy no')
        if (!yesBtn || !noBtn) {
          console.log('[clip] Buy buttons not found')
          return null
        }

        const title = (document.querySelector('h1') as HTMLElement | null) || null
        if (!title) {
          console.log('[clip] Title not found')
          return null
        }

        // Manually extract rect values (DOMRect doesn't serialize properly)
        const yRect = yesBtn.getBoundingClientRect()
        const nRect = noBtn.getBoundingClientRect()
        const tRect = title.getBoundingClientRect()

        const yesBottom = yRect.bottom
        const noBottom = nRect.bottom
        const titleTop = tRect.top

        // Convert viewport coords -> page coords using scrollY
        const scrollY = window.scrollY || 0

        const topY = Math.max(0, titleTop + scrollY - 24) // padding above title
        const bottomY = Math.max(yesBottom + scrollY, noBottom + scrollY) + 24 // padding below buttons

        // The crop height we want
        const cropHeight = h

        // If the content fits in the crop, start from topY
        // Otherwise, start from bottomY - cropHeight to ensure buttons are included
        let desiredY: number
        if (bottomY - topY <= cropHeight) {
          // Everything fits — start from top
          desiredY = topY
        } else {
          // Content is taller than crop — anchor to bottom (include buttons)
          desiredY = bottomY - cropHeight
        }

        console.log('[clip] titleTop:', titleTop, 'yesBottom:', yesBottom, 'scrollY:', scrollY, 'desiredY:', desiredY)

        return {
          x: 0,
          y: Math.floor(Math.max(0, desiredY)),
          width: Math.floor(w),
          height: Math.floor(cropHeight),
        }
      }, width, height)

      if (!rect) return null
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    } catch (err) {
      console.error('[clip] Error computing clip:', err)
      return null
    }
  }

  /**
   * Capture a screenshot of a Polymarket market page optimized for square (1:1 aspect ratio)
   * @param polymarketUrl - The URL of the Polymarket market page
   * @param options - Screenshot options (width, deviceScaleFactor)
   */
  async captureMarketScreenshot(
    polymarketUrl: string,
    options: ScreenshotOptions = {}
  ): Promise<ScreenshotResult> {
    if (!this.browser) {
      return { success: false, error: 'Browser not initialized' }
    }

    const { valid, cleanUrl, slug, nestedMarketSlug } = parsePolymarketUrl(polymarketUrl)
    if (!valid) {
      return { success: false, error: 'Invalid Polymarket URL. Please provide a valid polymarket.com/event/... or polymarket.com/market/... URL' }
    }

    const page = await this.browser.newPage()

    try {
      // Square 1:1 aspect ratio settings
      // Using 800px width for good resolution, height = 800px
      const width = options.width || 800
      const height = Math.round(width * SQUARE_ASPECT_RATIO)
      const deviceScaleFactor = options.deviceScaleFactor || 2
      const debugLayout = options.debugLayout === true

      console.log(`📐 Setting viewport to ${width}x${height} (1:1 square aspect ratio)`)

      // Use a taller viewport than the final crop so we can include title + chart + buy buttons reliably.
      const workingViewportHeight = Math.max(1200, height + 500)

      await page.setViewport({
        width,
        height: workingViewportHeight,
        deviceScaleFactor,
        // We want the mobile layout (like your reference screenshot)
        isMobile: true,
        hasTouch: true
      })

      // Use a mobile user agent to trigger mobile layout with fixed bottom Buy bar
      await page.setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      )
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

      // Force light mode (best-effort) BEFORE any site JS runs.
      // IMPORTANT: Avoid mutating documentElement/classes here; Polymarket can fail to render
      // under headless UA if we touch DOM too early. localStorage + media emulation is safe.
      await page.evaluateOnNewDocument(() => {
        try {
          localStorage.setItem('theme', 'light')
          localStorage.setItem('color-theme', 'light')
        } catch {}
      })

      try {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
      } catch {
        // Some Puppeteer builds/types mismatch here; theme still forced via evaluateOnNewDocument.
      }

      console.log(`📸 Navigating to ${cleanUrl}`)

      // Capture browser console logs for debugging
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('[DEBUG]')) {
          console.log('🌐 Browser:', text)
        }
      })

      await page.goto(cleanUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })

      // Wait for page to fully load
      await this.waitForPageLoad(page)
      await this.waitForFonts(page)

      // Get the page title for metadata
      const marketTitle = await page.title()
      const cleanTitle = marketTitle.replace(' Betting Odds & Predictions | Polymarket', '').trim()

      // Wait for chart to be ready (works for both single markets and multi-outcome event pages)
      console.log('⏳ Waiting for chart to load...')
      try {
        await page.waitForFunction(
          () => {
            // Look for chart container or canvas element
            const chart = document.querySelector('#group-chart-container, canvas, [class*="recharts"]')
            return !!chart
          },
          { timeout: 10000 }
        )
        console.log('✓ Chart loaded')
      } catch {
        console.log('⚠️ Chart not found, continuing anyway...')
      }
      await this.waitForFonts(page)

      // DOM manipulation for clean screenshot
      const chartWatermark: ChartWatermarkMode =
        options.chartWatermark === true
          ? 'wordmark'
          : options.chartWatermark === false || options.chartWatermark === undefined
            ? 'none'
            : options.chartWatermark
      console.log('[DEBUG] chartWatermark option:', chartWatermark)
      await page.evaluate((watermarkMode: ChartWatermarkMode) => {
        const enableWatermark = watermarkMode !== 'none'
        // 1. FORCE LIGHT MODE
        document.documentElement.setAttribute('data-chart-watermark', watermarkMode)
        document.documentElement.classList.remove('dark')
        document.documentElement.classList.add('light')
        document.documentElement.setAttribute('data-theme', 'light')
        document.documentElement.style.colorScheme = 'light'
        document.body.classList.remove('dark')
        document.body.classList.add('light')

        // 2. HIDE TOP HEADER (Polymarket logo, Log In, Sign Up)
        const headers = document.querySelectorAll('header')
        headers.forEach(header => {
          const text = (header as HTMLElement).textContent || ''
          if (text.includes('Log In') || text.includes('Sign Up')) {
            ;(header as HTMLElement).style.display = 'none'
          }
        })

        // NESTED MARKET CLEANUP: Hide the "back button" header and other nested-view artifacts
        // This header appears when clicking into a market from an event page on mobile
        const buttons = Array.from(document.querySelectorAll('button'))
        buttons.forEach(btn => {
          // Look for the back button (usually has a rotated arrow SVG)
          const svg = btn.querySelector('svg')
          if (svg && (svg.classList.contains('rotate-90') || btn.getAttribute('aria-label') === 'Back')) {
            const headerContainer = btn.closest('div.flex.justify-between.items-center') as HTMLElement | null
            if (headerContainer) {
              headerContainer.style.setProperty('display', 'none', 'important')
            }
          }
          // Hide the "< />" developer/source code button often found in nested views
          if (btn.querySelector('svg.lucide-code') || btn.innerHTML.includes('polyline points="16 18 22 12 16 6"')) {
             btn.style.setProperty('display', 'none', 'important')
          }
        })
        
        // Also hide the separate "JD Vance" title if we are going to show the main H1?
        // Actually, on nested pages, the "JD Vance" IS the H1. We just need to ensure we override it.

        // 2b. TITLE + HEADER CLUSTER SIZING/POSITIONING (match reference layout)
        const title = document.querySelector('h1') as HTMLElement | null
        if (title) {
          // Scale up to match native mobile Polymarket sizing in your reference
          // Polymarket uses Tailwind "!" classes (e.g. `!text-xl`) which are `!important`,
          // so we must also apply our overrides as important.
          title.style.setProperty('font-size', '30px', 'important')
          title.style.setProperty('line-height', '1.15', 'important')
          title.style.setProperty('margin-top', '0px', 'important')
          title.style.setProperty('margin-bottom', '10px', 'important')
          title.style.setProperty('padding-top', '0px', 'important')
        }

        // Remove the Middle East warning banner if present
        const middleEastBanner = document.querySelector('#middle-east-warning-banner') as HTMLElement | null
        if (middleEastBanner) {
          middleEastBanner.remove()
        }

        // Enlarge market icon (image to the left of the title)
        // In your snippet it's an <img alt="Market icon"> inside a sized wrapper.
        const marketIcon = document.querySelector('img[alt="Market icon"]') as HTMLImageElement | null
        if (marketIcon) {
          // Next/Image uses `fill` here: the <img> is absolute with width/height 100%.
          // To actually make it bigger, we must resize the *box div* that controls layout.
          // From your snippet this is the div with classes like:
          // `rounded-sm overflow-hidden relative !h-10 !w-10 !min-w-10 ...`
          const targetSize = '80px' // bump above the default ~64px so the change is obvious

          const iconBox =
            (marketIcon.closest('div.rounded-sm.overflow-hidden.relative') as HTMLElement | null) ||
            (marketIcon.closest('div.rounded-sm.overflow-hidden') as HTMLElement | null) ||
            (marketIcon.parentElement as HTMLElement | null)

          const boxes: HTMLElement[] = []
          if (iconBox) boxes.push(iconBox)
          if (iconBox?.parentElement) boxes.push(iconBox.parentElement as HTMLElement)
          if (iconBox?.parentElement?.parentElement) boxes.push(iconBox.parentElement.parentElement as HTMLElement)

          boxes.forEach(el => {
            el.style.setProperty('width', targetSize, 'important')
            el.style.setProperty('height', targetSize, 'important')
            el.style.setProperty('min-width', targetSize, 'important')
            el.style.setProperty('min-height', targetSize, 'important')
            // Ensure the `fill` image is constrained to this resized box
            if (getComputedStyle(el).position === 'static') {
              el.style.setProperty('position', 'relative', 'important')
            }
          })

          // Defensive: if Polymarket applies transforms higher up, ensure we don't get scaled down.
          if (iconBox) {
            iconBox.style.setProperty('transform', 'none', 'important')
          }
        }

        // Enlarge the "X% chance" row below the title.
        // Polymarket uses <number-flow-react> with a shadow DOM; font-size on the host applies.
        const chanceNumber = document.querySelector('number-flow-react') as HTMLElement | null
        if (chanceNumber) {
          chanceNumber.style.fontSize = '30px'
          chanceNumber.style.lineHeight = '1.1'

          // Enlarge the small up/down triangle icon next to the % change (often a 12x12 svg).
          // It's not inside <number-flow-react>; it's a sibling within the same "chance" cluster.
          const candidates: Array<HTMLElement | null | undefined> = [
            chanceNumber.parentElement as HTMLElement | null,
            (chanceNumber.closest('div')?.parentElement as HTMLElement | null) || null,
            (chanceNumber.closest('div')?.parentElement?.parentElement as HTMLElement | null) || null,
          ]

          for (const c of candidates) {
            if (!c) continue
            const svgs = Array.from(c.querySelectorAll('svg')) as SVGElement[]
            svgs.forEach(svg => {
              const vb = svg.getAttribute('viewBox') || ''
              const wAttr = svg.getAttribute('width') || ''
              const hAttr = svg.getAttribute('height') || ''
              const looksLikeDeltaArrow = vb === '0 0 12 12' || wAttr === '12' || hAttr === '12'
              if (!looksLikeDeltaArrow) return

              const el = svg as unknown as HTMLElement
              el.style.setProperty('width', '16px', 'important')
              el.style.setProperty('height', '16px', 'important')
            })

            // Scale the delta number container (odometer-style digit stack + %).
            // Using transform: scale() is the safest way to enlarge it without breaking
            // the internal translateY positioning of the stacked digits.
            const deltaContainer = c.querySelector('div.flex.items-center.w-auto') as HTMLElement | null
            if (deltaContainer) {
              // Scale the *overflow-hidden* wrapper instead of the inner container.
              // This keeps the digit stack clipped while making the whole delta larger.
              const overflowWrapper = deltaContainer.closest('div.overflow-hidden') as HTMLElement | null
              if (overflowWrapper) {
                overflowWrapper.style.setProperty('transform', 'scale(1.35)', 'important')
                overflowWrapper.style.setProperty('transform-origin', 'left center', 'important')
                // Keep clipping so the digit stack doesn't show every number.
                overflowWrapper.style.setProperty('overflow', 'hidden', 'important')
              } else {
                // Fallback: scale the inner container if no wrapper found.
                deltaContainer.style.setProperty('transform', 'scale(1.35)', 'important')
                deltaContainer.style.setProperty('transform-origin', 'left center', 'important')
              }
            }
          }
        }

        // Enlarge the Polymarket logo on the right (the big wordmark svg).
        // From your snippet: `<svg ... viewBox="0 0 911 168" class="... h-6 ...">`
        const polymarketLogos = Array.from(
          document.querySelectorAll('svg[viewBox="0 0 911 168"]')
        ) as HTMLElement[]
        polymarketLogos.forEach(logo => {
          const container = logo.closest('div.ml-auto.self-end') as HTMLElement | null
          // Scale proportionally (was ~24px via `h-6`; bump to ~32px)
          logo.style.setProperty('height', '32px', 'important')
          logo.style.setProperty('width', 'auto', 'important')
        })

        // Enlarge the Share and Add to favorites buttons (top-right action icons).
        // Target by aria-label attributes and scale both buttons and their SVGs.
        const shareButton = document.querySelector('button[aria-label="Share"]') as HTMLElement | null
        if (shareButton) {
          shareButton.style.setProperty('width', '24px', 'important')
          shareButton.style.setProperty('height', '24px', 'important')
          shareButton.style.setProperty('padding', '2px', 'important')
          const shareSvg = shareButton.querySelector('svg') as HTMLElement | null
          if (shareSvg) {
            shareSvg.style.setProperty('width', '22px', 'important')
            shareSvg.style.setProperty('height', '22px', 'important')
          }
        }

        const favoritesButton = document.querySelector('button[aria-label="Add to favorites"]') as HTMLElement | null
        if (favoritesButton) {
          favoritesButton.style.setProperty('width', '24px', 'important')
          favoritesButton.style.setProperty('height', '24px', 'important')
          favoritesButton.style.setProperty('padding', '2px', 'important')
          // The bookmarkButton div may contain an SVG or other icon
          const bookmarkIcon = favoritesButton.querySelector('.bookmarkButton') as HTMLElement | null
          if (bookmarkIcon) {
            bookmarkIcon.style.setProperty('width', '22px', 'important')
            bookmarkIcon.style.setProperty('height', '22px', 'important')
            const bookmarkSvg = bookmarkIcon.querySelector('svg') as HTMLElement | null
            if (bookmarkSvg) {
              bookmarkSvg.style.setProperty('width', '22px', 'important')
              bookmarkSvg.style.setProperty('height', '22px', 'important')
            }
          }
        }

        // 3. HIDE STICKY CATEGORY NAV (Trending, Breaking, New, etc.)
        document.querySelectorAll('nav').forEach(nav => {
          const style = window.getComputedStyle(nav as HTMLElement)
          const text = (nav as HTMLElement).textContent || ''
          if (style.position === 'sticky' && (text.includes('Trending') || text.includes('Breaking'))) {
            ;(nav as HTMLElement).style.display = 'none'
          }
        })

        // 4. HIDE CONTENT SECTIONS BELOW CHART (Order Book, Market Context, About, Comments)
        const sectionsToHide = ['Order Book', 'Market Context', 'About', 'Comments', 'Top Holders', 'Activity']
        const allElements = document.querySelectorAll('main *')
        allElements.forEach(el => {
          const element = el as HTMLElement
          // Look for section headers/titles
          if (element.tagName === 'BUTTON' || element.tagName === 'DIV' || element.tagName === 'H2' || element.tagName === 'H3') {
            const text = element.textContent?.trim() || ''
            // Check if this is a section header we want to hide
            for (const section of sectionsToHide) {
              if (text === section || text.startsWith(section)) {
                // Find the parent card/section container and hide it
                let parent = element.parentElement
                for (let i = 0; i < 5 && parent; i++) {
                  const parentText = parent.textContent || ''
                  // If parent is a card-like container (has border/rounded classes or is relatively small)
                  const rect = parent.getBoundingClientRect()
                  if (rect.height < 200 && rect.height > 30) {
                    parent.style.display = 'none'
                    break
                  }
                  parent = parent.parentElement
                }
              }
            }
          }
        })

        // 5. HIDE FIXED BOTTOM NAV ELEMENTS (keep only Buy buttons)
        const fixedNavs = Array.from(document.querySelectorAll('nav')).filter(nav => {
          const style = window.getComputedStyle(nav as HTMLElement)
          return style.position === 'fixed'
        })

        fixedNavs.forEach(nav => {
          const navEl = nav as HTMLElement
          const hasBuyButtons = !!navEl.querySelector('.trading-button')

          if (hasBuyButtons) {
            // This is the Buy button nav - hide non-button sections
            const allChildren = navEl.querySelectorAll('*')
            allChildren.forEach(child => {
              const childEl = child as HTMLElement
              const text = childEl.textContent?.trim() || ''
              // Hide "How it works" elements
              if (text === 'How it works' || text.includes('How it works')) {
                // IMPORTANT: Never hide a container that also contains the trading buttons.
                // Production DOM can nest "How it works" alongside the Buy buttons.
                const candidate =
                  (childEl.closest('div.rounded-t-lg') as HTMLElement | null) ||
                  (childEl.closest('div[class*="rounded-t"]') as HTMLElement | null) ||
                  (childEl.closest('div[class*="border-t"]') as HTMLElement | null) ||
                  (childEl.parentElement as HTMLElement | null)

                if (candidate && !candidate.querySelector('.trading-button')) {
                  candidate.style.display = 'none'
                }
              }
            })
            // Hide the bottom tab bar (Home, Search, Breaking, More)
            const bottomTabs = navEl.querySelectorAll('a[href="/"], a[href*="search"], a[href*="breaking"]')
            bottomTabs.forEach(tab => {
              let parent = (tab as HTMLElement).parentElement
              while (parent && parent !== navEl) {
                // Never hide any wrapper that contains the trading buttons.
                if (parent.querySelector('.trading-button')) {
                  break
                }
                if (parent.parentElement === navEl || parent.parentElement?.parentElement === navEl) {
                  parent.style.display = 'none'
                  break
                }
                parent = parent.parentElement
              }
            })
          } else {
            // Nav without Buy buttons - hide entirely
            navEl.style.display = 'none'
          }
        })

        // 6. ADJUST MAIN CONTENT - reduce (not remove) top padding to match reference
        const main = document.querySelector('main')
        if (main) {
          ;(main as HTMLElement).style.marginTop = '0'
          // Keep a small buffer so the title isn't glued to the top edge
          ;(main as HTMLElement).style.paddingTop = '8px'
        }
        document.body.style.paddingTop = '0'
        document.body.style.marginTop = '0'

        // 6b. Target the *specific* mobile wrapper that adds the big gap: `pt-4` (16px)
        // HTML (from your snippet): `div.flex.w-full.px-4.h-full.pt-4.box-border`
        const paddedWrappers = document.querySelectorAll('main .px-4.pt-4') as NodeListOf<HTMLElement>
        paddedWrappers.forEach(el => {
          // Bring it closer to the top, but keep a little air like the reference
          el.style.paddingTop = '10px'
        })

        // 6c. Target the sticky title container (has `py-2 sticky ... top-[104px]`)
        // Keep some padding, just smaller than default.
        const stickyTitleWrappers = Array.from(document.querySelectorAll('main .sticky')) as HTMLElement[]
        stickyTitleWrappers.forEach(el => {
          if (el.querySelector('h1')) {
            el.style.paddingTop = '8px'
            el.style.paddingBottom = '8px'
            // Keep it in normal flow (no sticky offset affecting layout when header hidden)
            el.style.position = 'relative'
            el.style.top = '0'
          }
        })

        // 7. Hide popups/modals
        document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"]').forEach(el => {
          ;(el as HTMLElement).style.display = 'none'
        })

        // 8. HIDE "How it works" BANNER above the buy buttons
        // DEBUG: Log what we find
        const howItWorksSpans = document.querySelectorAll('span')
        let foundHowItWorks = false
        howItWorksSpans.forEach(span => {
          if ((span as HTMLElement).textContent?.trim() === 'How it works') {
            foundHowItWorks = true
            const parent = span.parentElement
            const grandparent = parent?.parentElement
            console.log('[DEBUG] Found "How it works" span')
            console.log('[DEBUG] Parent tag:', parent?.tagName, 'classes:', parent?.className)
            console.log('[DEBUG] Grandparent tag:', grandparent?.tagName, 'classes:', grandparent?.className)
          }
        })
        if (!foundHowItWorks) {
          console.log('[DEBUG] No "How it works" span found')
        }

        // Target the specific div with classes: rounded-t-lg, border-t, lg:hidden
        document.querySelectorAll('div.rounded-t-lg').forEach(el => {
          const div = el as HTMLElement
          if (div.textContent?.includes('How it works')) {
            console.log('[DEBUG] Removing div.rounded-t-lg with "How it works"')
            div.remove()
          }
        })
        // Also target by lg:hidden class pattern
        document.querySelectorAll('div[class*="lg\\:hidden"]').forEach(el => {
          const div = el as HTMLElement
          if (div.textContent?.includes('How it works')) {
            console.log('[DEBUG] Removing div with lg:hidden containing "How it works"')
            div.remove()
          }
        })
        // Fallback: find the span and remove its ancestor
        document.querySelectorAll('span').forEach(span => {
          if ((span as HTMLElement).textContent?.trim() === 'How it works') {
            console.log('[DEBUG] Fallback: trying to remove via span.closest()')
            const container = span.closest('div.rounded-t-lg') || span.closest('div[class*="border-t"]')
            if (container) {
              console.log('[DEBUG] Found container to remove:', container.className)
              container.remove()
            } else {
              // Last resort: just remove parent elements up the chain
              console.log('[DEBUG] No container found, removing parent chain')
              let el: HTMLElement | null = span.parentElement as HTMLElement
              while (el && el.tagName !== 'NAV' && el.tagName !== 'BODY') {
                const next = el.parentElement as HTMLElement | null
                if (el.classList.contains('bg-background') || el.classList.contains('border-t')) {
                  console.log('[DEBUG] Removing element with bg-background or border-t:', el.className)
                  el.remove()
                  break
                }
                el = next
              }
            }
          }
        })

        // 9. INCREASE CHART HEIGHT - make the chart take up more vertical space
        const findChartContainer = (): HTMLElement | null => {
          const byId = document.querySelector('#group-chart-container') as HTMLElement | null
          if (byId) return byId

          const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
          if (byTestId) return byTestId

          const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
          if (byClass) return byClass

          const byChartSvg = document.querySelector(
            '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
          ) as SVGElement | null
          if (byChartSvg) {
            return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
          }

          return null
        }

        const chartContainer = findChartContainer()
        console.log('[DEBUG] chartWatermark enabled:', enableWatermark)
        console.log('[DEBUG] chartContainer found:', !!chartContainer)
        if (chartContainer) {
          // Increase chart height from default 272px to a square-friendly height.
          // If the date chips row is present, reduce height to avoid
          // pushing the volume/tabs row under the Buy buttons.
          const baseChartHeight = 340
          let reduceBy = 0
          const monthRe = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$/i
          const getChipsRow = (): HTMLElement | null => {
            const chipCandidates = Array.from(document.querySelectorAll('button, a, div'))
              .map(el => (el as HTMLElement))
              .map(el => el.classList.contains('rounded-full') ? el : (el.closest('.rounded-full') as HTMLElement | null))
              .filter((el): el is HTMLElement => !!el)
              .filter(el => {
                const text = (el.textContent || '').trim()
                return text === 'Past' || monthRe.test(text)
              })

            const uniqueChips = Array.from(new Set(chipCandidates))
            if (uniqueChips.length < 2) return null

            let el: HTMLElement | null = uniqueChips[0]
            for (let i = 0; i < 8 && el; i++) {
              const current = el
              const count = uniqueChips.filter(c => current.contains(c)).length
              if (count >= 2) {
                const className = current.className || ''
                const style = window.getComputedStyle(current)
                if (
                  style.display.includes('flex') ||
                  className.includes('overflow-x-auto') ||
                  className.includes('snap-x')
                ) {
                  const pyRow =
                    (current.closest('div.py-4') as HTMLElement | null) ||
                    (current.closest('div[class*="py-"]') as HTMLElement | null)
                  return pyRow || current
                }
              }
              el = current.parentElement as HTMLElement | null
            }
            const fallback =
              (uniqueChips[0].closest('div.py-4') as HTMLElement | null) ||
              (uniqueChips[0].closest('div[class*="py-"]') as HTMLElement | null) ||
              (uniqueChips[0].parentElement as HTMLElement | null)
            return fallback
          }

          const chipsRow = getChipsRow()
          if (chipsRow) {
            const chipsHeight = Math.round(chipsRow.getBoundingClientRect().height)
            reduceBy = Math.min(90, Math.max(28, chipsHeight))
          }
          const newChartHeight = `${Math.max(300, baseChartHeight - reduceBy)}px`
          chartContainer.style.setProperty('--chart-height', newChartHeight, 'important')
          chartContainer.style.setProperty('height', newChartHeight, 'important')
          chartContainer.style.setProperty('min-height', newChartHeight, 'important')

          // Also resize the SVG inside the chart container
          const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
          if (chartSvg) {
            chartSvg.setAttribute('height', newChartHeight.replace('px', ''))
            chartSvg.style.setProperty('height', newChartHeight, 'important')
          }

          if (enableWatermark) {
            console.log('[DEBUG] Applying chart watermark overlay')
            // Ensure the chart container is positioned for absolute overlays
            const chartStyle = window.getComputedStyle(chartContainer)
            if (chartStyle.position === 'static') {
              chartContainer.style.setProperty('position', 'relative', 'important')
            }

            // Remove any existing watermark first (idempotent)
            const existing = chartContainer.querySelector('#chart-watermark-overlay')
            if (existing) {
              existing.remove()
            }

            const overlay = document.createElement('div')
            overlay.id = 'chart-watermark-overlay'
            overlay.style.setProperty('position', 'absolute', 'important')
            overlay.style.setProperty('inset', '0', 'important')
            overlay.style.setProperty('display', 'flex', 'important')
            overlay.style.setProperty('align-items', 'center', 'important')
            overlay.style.setProperty('justify-content', 'center', 'important')
            overlay.style.setProperty('pointer-events', 'none', 'important')
            overlay.style.setProperty('z-index', '2', 'important')
            overlay.style.setProperty('opacity', '0.08', 'important')
            overlay.style.setProperty('transform', 'none', 'important')

            const buildWordmark = (): Node => {
              const logoSvg =
                (document.querySelector('div.ml-auto.self-end svg[viewBox="0 0 911 168"]') as SVGElement | null) ||
                (document.querySelector('svg[viewBox="0 0 911 168"]') as SVGElement | null)
              console.log('[DEBUG] Watermark wordmark SVG found:', !!logoSvg)
              if (logoSvg) {
                const clone = logoSvg.cloneNode(true) as SVGElement
                clone.removeAttribute('height')
                clone.removeAttribute('width')
                clone.style.setProperty('height', '90px', 'important')
                clone.style.setProperty('width', 'auto', 'important')
                clone.style.setProperty('opacity', '1', 'important')
                clone.style.setProperty('color', '#9ca3af', 'important')
                return clone
              }
              console.log('[DEBUG] Wordmark SVG missing, using text fallback')
              const text = document.createElement('div')
              text.textContent = 'Polymarket'
              text.style.setProperty('font-size', '36px', 'important')
              text.style.setProperty('font-weight', '700', 'important')
              text.style.setProperty('color', '#9ca3af', 'important')
              return text
            }

            const buildIcon = (): Node => {
              const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
              svg.setAttribute('viewBox', '0 0 137 165')
              svg.setAttribute('fill', 'none')
              svg.style.setProperty('height', '330px', 'important')
              svg.style.setProperty('width', '330px', 'important')
              svg.style.setProperty('opacity', '1', 'important')
              svg.style.setProperty('color', '#9ca3af', 'important')

              const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
              path.setAttribute(
                'd',
                'M136.267 152.495c0 7.265 0 10.897-2.376 12.697-2.375 1.801-5.872.82-12.867-1.143L8.632 132.51c-4.214-1.182-6.321-1.773-7.54-3.381-1.218-1.607-1.218-3.796-1.218-8.172V47.043c0-4.376 0-6.565 1.218-8.172 1.219-1.608 3.326-2.199 7.54-3.381L121.024 3.95c6.995-1.963 10.492-2.944 12.867-1.143s2.376 5.432 2.376 12.697zM27.904 122.228l93.062 26.117V96.113zm-12.73-12.117L108.217 84 15.174 57.889zm12.73-64.339 93.062 26.116V19.655z'
              )
              path.setAttribute('fill', 'currentColor')
              svg.appendChild(path)
              return svg
            }

            const node: Node = watermarkMode === 'icon' ? buildIcon() : buildWordmark()
            overlay.appendChild(node)

            chartContainer.appendChild(overlay)
          }
        }
      }, chartWatermark)
      console.log('[DEBUG] chartWatermark evaluate completed')

      // Let layout settle after DOM manipulation
      // Use a shorter wait, just enough for styles to apply
      await new Promise(resolve => setTimeout(resolve, 100))

      // Keep the larger viewport for now to capture more content
      // We'll clip to 1:1 aspect ratio after

      // Scroll to top so title is visible, then take viewport screenshot
      // Fixed elements (like the Buy button bar) will appear at bottom of viewport
      await page.evaluate(() => window.scrollTo(0, 0))
      await new Promise(resolve => setTimeout(resolve, 100))

      // Resize to our target 1:1 aspect ratio
      await page.setViewport({
        width,
        height,
        deviceScaleFactor,
        isMobile: true,
        hasTouch: true
      })
      // Small buffer for resize repaint
      await new Promise(resolve => setTimeout(resolve, 100))

      // Final cleanup pass - remove "How it works" right before screenshot
      // This catches elements that may have been added after initial DOM manipulation
      await page.evaluate(() => {
        const hideElement = (el: HTMLElement | null) => {
          if (!el) return
          el.style.setProperty('display', 'none', 'important')
        }

        // Target only direct UI elements with "How it works" text (avoid large containers)
        const howTargets = Array.from(
          document.querySelectorAll('button, a, span')
        ).filter(el => /how it works/i.test((el as HTMLElement).textContent || '')) as HTMLElement[]

        howTargets.forEach(target => {
          const button = target.closest('button') as HTMLElement | null
          const link = target.closest('a') as HTMLElement | null
          const candidate = button || link || target

          // Never hide a container that also contains trading buttons.
          if (candidate.querySelector('.trading-button')) {
            hideElement(target)
          } else {
            hideElement(candidate)
          }
        })

        // Find and remove/hide "How it works" banner.
        // IMPORTANT: Some Polymarket layouts render "How it works" inside the *same fixed bar*
        // container as the Buy buttons. In those cases, we must hide only the banner sub-tree,
        // never the entire fixed container.
        const howSpans = Array.from(document.querySelectorAll('span')).filter(
          s => ((s as HTMLElement).textContent?.trim() || '') === 'How it works'
        ) as HTMLElement[]

        for (const span of howSpans) {
          // First: hide the closest clickable/container element (surgical).
          const clickable =
            (span.closest('button') as HTMLElement | null) ||
            (span.closest('a') as HTMLElement | null) ||
            (span.parentElement as HTMLElement | null)

          if (clickable) {
            if (clickable.querySelector('.trading-button')) {
              // Shared container with buy buttons — hide only the text + its immediate wrapper(s).
              span.style.setProperty('display', 'none', 'important')
              let p: HTMLElement | null = span.parentElement as HTMLElement | null
              for (let i = 0; i < 4 && p; i++) {
                if (!p.querySelector('.trading-button')) {
                  p.style.setProperty('display', 'none', 'important')
                  break
                }
                p = p.parentElement as HTMLElement | null
              }
            } else {
              clickable.style.setProperty('display', 'none', 'important')
            }
          } else {
            span.style.setProperty('display', 'none', 'important')
          }

          // Second: try to remove the dedicated banner container if it exists and is safe to remove.
          let el: HTMLElement | null = span as HTMLElement
          for (let i = 0; i < 10 && el; i++) {
            el = el.parentElement as HTMLElement | null
            if (!el) break

            const classes = el.className || ''
            const looksLikeBanner =
              classes.includes('rounded-t-lg') ||
              classes.includes('lg:hidden') ||
              (classes.includes('border-t') && classes.includes('py-3')) ||
              ((el.textContent || '').includes('How it works') && classes.includes('bg-background'))

            if (!looksLikeBanner) continue

            if (el.querySelector('.trading-button')) {
              // Shared ancestor with buy buttons — already hidden surgically above.
              break
            }

            console.log('[DEBUG] Final pass: removing', classes)
            el.remove()
            break
          }
        }

        // Hide "Related" heading - we want Vol row to be right above Buy buttons
        document.querySelectorAll('h3').forEach(h3 => {
          const text = (h3 as HTMLElement).textContent?.trim() || ''
          if (text === 'Related') {
            // Remove the Related heading and its container
            const parent = h3.parentElement
            if (parent) {
              parent.remove()
            } else {
              (h3 as HTMLElement).remove()
            }
          }
        })

        // Make Vol row text and buttons larger
        // Find the Vol text (contains "Vol.")
        document.querySelectorAll('p').forEach(p => {
          const text = (p as HTMLElement).textContent || ''
          if (text.includes('Vol.')) {
            // Hide volume line entirely if under $50,000
            const raw = text.replace(/[^0-9.,]/g, '')
            const numeric = Number(raw.replace(/,/g, ''))
            const volContainer = p.closest('div.flex.items-center.gap-2\\.5') as HTMLElement | null
            if (!Number.isNaN(numeric) && numeric < 50000 && volContainer) {
              volContainer.style.setProperty('display', 'none', 'important')
              return
            }

            ;(p as HTMLElement).style.setProperty('font-size', '18px', 'important')
            ;(p as HTMLElement).style.setProperty('font-weight', '600', 'important')
            // Move the row down (closer to Buy buttons) by adding top margin
            // and reducing the bottom margin.
            const rowContainer =
              (p.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null) ||
              (p.closest('div.flex.w-full') as HTMLElement | null)
            if (rowContainer) {
              rowContainer.style.setProperty('margin-top', '16px', 'important')
              rowContainer.style.setProperty('margin-bottom', '6px', 'important')
            }
          }
        })
        // Make the time period tabs larger (1H, 6H, 1D, MAX)
        document.querySelectorAll('button[role="tab"]').forEach(btn => {
          const button = btn as HTMLElement
          button.style.setProperty('font-size', '17px', 'important')
          button.style.setProperty('padding', '6px 8px', 'important')
          button.style.setProperty('font-weight', '500', 'important')
        })
        // Make the settings icon larger
        document.querySelectorAll('svg[viewBox="0 0 18 18"]').forEach(svg => {
          const el = svg as HTMLElement
          el.style.setProperty('width', '24px', 'important')
          el.style.setProperty('height', '24px', 'important')
        })

        // Make chart axis labels visible (x-axis timestamps)
        // Set the CSS variable to original Polymarket light gray
        document.documentElement.style.setProperty('--neutral-200', '#9ca3af', 'important')

        // Don't override fill attributes - let them use var(--neutral-200) naturally
        // Just ensure visibility and proper sizing

        // Force all axis ticks to be visible
        document.querySelectorAll('.visx-axis-tick').forEach(tick => {
          const el = tick as SVGGElement
          el.setAttribute('opacity', '1')
          el.style.opacity = '1'
          el.style.display = 'block'
        })

        // NOTE: Buy button styling is now handled by styleBuyButtons() rule
        // which is called after all DOM manipulation is complete

        // If a "Past / Date" chips row is present, shrink the chart so the
        // volume/tabs row stays above the Buy buttons.
        const monthRe = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$/i
        const getChipsRow = (): HTMLElement | null => {
          const chipCandidates = Array.from(document.querySelectorAll('button, a, div'))
            .map(el => (el as HTMLElement))
            .map(el => el.classList.contains('rounded-full') ? el : (el.closest('.rounded-full') as HTMLElement | null))
            .filter((el): el is HTMLElement => !!el)
            .filter(el => {
              const text = (el.textContent || '').trim()
              return text === 'Past' || monthRe.test(text)
            })

          const uniqueChips = Array.from(new Set(chipCandidates))
          if (uniqueChips.length < 2) return null

          let el: HTMLElement | null = uniqueChips[0]
          for (let i = 0; i < 8 && el; i++) {
            const current = el
            const count = uniqueChips.filter(c => current.contains(c)).length
            if (count >= 2) {
              const className = current.className || ''
              const style = window.getComputedStyle(current)
              if (
                style.display.includes('flex') ||
                className.includes('overflow-x-auto') ||
                className.includes('snap-x')
              ) {
                const pyRow =
                  (current.closest('div.py-4') as HTMLElement | null) ||
                  (current.closest('div[class*="py-"]') as HTMLElement | null)
                return pyRow || current
              }
            }
            el = current.parentElement as HTMLElement | null
          }
          const fallback =
            (uniqueChips[0].closest('div.py-4') as HTMLElement | null) ||
            (uniqueChips[0].closest('div[class*="py-"]') as HTMLElement | null) ||
            (uniqueChips[0].parentElement as HTMLElement | null)
          return fallback
        }

        const chipsRow = getChipsRow()
        if (chipsRow) {
          const findChartContainer = (): HTMLElement | null => {
            const byId = document.querySelector('#group-chart-container') as HTMLElement | null
            if (byId) return byId
            const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
            if (byTestId) return byTestId
            const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
            if (byClass) return byClass
            const byChartSvg = document.querySelector(
              '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
            ) as SVGElement | null
            if (byChartSvg) {
              return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
            }
            return null
          }

          const chartContainer = findChartContainer()
          if (chartContainer) {
            const baseChartHeight = 340
            const chipsHeight = Math.round(chipsRow.getBoundingClientRect().height)
            const reduceBy = Math.min(90, Math.max(28, chipsHeight))
            const newChartHeight = `${Math.max(300, baseChartHeight - reduceBy)}px`
            chartContainer.style.setProperty('--chart-height', newChartHeight, 'important')
            chartContainer.style.setProperty('height', newChartHeight, 'important')
            chartContainer.style.setProperty('min-height', newChartHeight, 'important')
            const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
            if (chartSvg) {
              chartSvg.setAttribute('height', newChartHeight.replace('px', ''))
              chartSvg.style.setProperty('height', newChartHeight, 'important')
            }
          }
        }

        // Square layout: ensure the Vol row is visible above the fixed Buy bar by
        // trimming chart height if needed. This preserves existing paddings/margins
        // and only shrinks the chart when it would overlap the Buy container.
        const findChartContainer = (): HTMLElement | null => {
          const byId = document.querySelector('#group-chart-container') as HTMLElement | null
          if (byId) return byId
          const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
          if (byTestId) return byTestId
          const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
          if (byClass) return byClass
          const byChartSvg = document.querySelector(
            '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
          ) as SVGElement | null
          if (byChartSvg) {
            return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
          }
          return null
        }

        const chartContainer = findChartContainer()
        const volText = Array.from(document.querySelectorAll('p')).find(p =>
          ((p as HTMLElement).textContent || '').includes('Vol.')
        ) as HTMLElement | undefined
        const volRow =
          (volText?.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null) ||
          (volText?.closest('div.flex.w-full') as HTMLElement | null) ||
          (volText?.closest('div') as HTMLElement | null)

        const tradingButtonEl = document.querySelector('.trading-button') as HTMLElement | null
        let buyContainer: HTMLElement | null = null
        if (tradingButtonEl) {
          let el: HTMLElement | null = tradingButtonEl
          for (let i = 0; i < 12 && el; i++) {
            const style = window.getComputedStyle(el)
            if (style.position === 'fixed') {
              buyContainer = el
              break
            }
            el = el.parentElement as HTMLElement | null
          }
          buyContainer =
            buyContainer ||
            (tradingButtonEl.closest('nav') as HTMLElement | null) ||
            (tradingButtonEl.closest('div') as HTMLElement | null)
        }

        if (chartContainer && volRow && buyContainer) {
          const buffer = 12
          const buyTop = buyContainer.getBoundingClientRect().top
          const volBottom = volRow.getBoundingClientRect().bottom
          if (volBottom >= buyTop - buffer) {
            const overlap = volBottom - (buyTop - buffer)
            const currentHeight = Math.round(chartContainer.getBoundingClientRect().height)
            const newHeight = Math.max(240, Math.round(currentHeight - overlap))
            chartContainer.style.setProperty('--chart-height', `${newHeight}px`, 'important')
            chartContainer.style.setProperty('height', `${newHeight}px`, 'important')
            chartContainer.style.setProperty('min-height', `${newHeight}px`, 'important')
            const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
            if (chartSvg) {
              chartSvg.setAttribute('height', `${newHeight}`)
              chartSvg.style.setProperty('height', `${newHeight}px`, 'important')
            }
          }
        }
      })
      if (debugLayout) {
        await page.evaluate(() => {
          const outlines: Array<{ el: HTMLElement; label: string; color: string }> = []
          const label = (text: string, color: string, top: number, left: number) => {
            const badge = document.createElement('div')
            badge.textContent = text
            badge.style.setProperty('position', 'fixed', 'important')
            badge.style.setProperty('top', `${top}px`, 'important')
            badge.style.setProperty('left', `${left}px`, 'important')
            badge.style.setProperty('background', color, 'important')
            badge.style.setProperty('color', '#fff', 'important')
            badge.style.setProperty('font-size', '12px', 'important')
            badge.style.setProperty('font-weight', '600', 'important')
            badge.style.setProperty('padding', '2px 6px', 'important')
            badge.style.setProperty('border-radius', '4px', 'important')
            badge.style.setProperty('z-index', '999999', 'important')
            badge.style.setProperty('opacity', '0.9', 'important')
            document.body.appendChild(badge)
          }

          const findChartContainer = (): HTMLElement | null => {
            const byId = document.querySelector('#group-chart-container') as HTMLElement | null
            if (byId) return byId
            const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
            if (byTestId) return byTestId
            const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
            if (byClass) return byClass
            const byChartSvg = document.querySelector(
              '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
            ) as SVGElement | null
            if (byChartSvg) {
              return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
            }
            return null
          }

          const monthRe = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$/i
          const getChipsRow = (): HTMLElement | null => {
            const chipCandidates = Array.from(document.querySelectorAll('button, a, div'))
              .map(el => (el as HTMLElement))
              .map(el => el.classList.contains('rounded-full') ? el : (el.closest('.rounded-full') as HTMLElement | null))
              .filter((el): el is HTMLElement => !!el)
              .filter(el => {
                const text = (el.textContent || '').trim()
                return text === 'Past' || monthRe.test(text)
              })

            const uniqueChips = Array.from(new Set(chipCandidates))
            if (uniqueChips.length < 2) return null

          let el: HTMLElement | null = uniqueChips[0]
          for (let i = 0; i < 8 && el; i++) {
            const current = el
            const count = uniqueChips.filter(c => current.contains(c)).length
            if (count >= 2) {
              const className = current.className || ''
              const style = window.getComputedStyle(current)
                if (
                  style.display.includes('flex') ||
                  className.includes('overflow-x-auto') ||
                  className.includes('snap-x')
                ) {
                  const pyRow =
                    (current.closest('div.py-4') as HTMLElement | null) ||
                    (current.closest('div[class*="py-"]') as HTMLElement | null)
                  return pyRow || current
                }
              }
            el = current.parentElement as HTMLElement | null
            }
             const fallback =
               (uniqueChips[0].closest('div.py-4') as HTMLElement | null) ||
               (uniqueChips[0].closest('div[class*="py-"]') as HTMLElement | null) ||
               (uniqueChips[0].parentElement as HTMLElement | null)
             return fallback
          }

          const chipsRow = getChipsRow()

          const chartContainer = findChartContainer()
          const volText = Array.from(document.querySelectorAll('p')).find(p =>
            ((p as HTMLElement).textContent || '').includes('Vol.')
          ) as HTMLElement | undefined
          const volRow =
            (volText?.closest('div.flex.w-full') as HTMLElement | null) ||
            (volText?.closest('div') as HTMLElement | null)

          const tradingButton = document.querySelector('.trading-button') as HTMLElement | null
          const buyContainer = tradingButton?.closest('div') as HTMLElement | null

          if (chipsRow) outlines.push({ el: chipsRow, label: 'chips-row', color: '#b45309' })
          if (chartContainer) outlines.push({ el: chartContainer, label: 'chart', color: '#2563eb' })
          if (volRow) outlines.push({ el: volRow, label: 'vol-row', color: '#16a34a' })
          if (buyContainer) outlines.push({ el: buyContainer, label: 'buy-container', color: '#dc2626' })

          outlines.forEach(({ el, label: name, color }) => {
            el.style.setProperty('outline', `2px solid ${color}`, 'important')
            const rect = el.getBoundingClientRect()
            label(`${name} ${Math.round(rect.height)}px`, color, Math.max(8, rect.top + 4), Math.max(8, rect.left + 4))
          })

          const summary = {
            chipsRowHeight: chipsRow ? Math.round(chipsRow.getBoundingClientRect().height) : null,
            chartHeight: chartContainer ? Math.round(chartContainer.getBoundingClientRect().height) : null,
            volRowTop: volRow ? Math.round(volRow.getBoundingClientRect().top) : null,
            buyContainerTop: buyContainer ? Math.round(buyContainer.getBoundingClientRect().top) : null,
          }
          console.log('[DEBUG_LAYOUT]', JSON.stringify(summary))
        })
      }
      // Some runs inject the banner a beat later; do a short second pass.
      await new Promise(resolve => setTimeout(resolve, 200))
      await page.evaluate(() => {
        const hideElement = (el: HTMLElement | null) => {
          if (!el) return
          el.style.setProperty('display', 'none', 'important')
        }

        const howTargets = Array.from(document.querySelectorAll('button, a, span, div'))
          .filter(el => /how it works/i.test((el as HTMLElement).textContent || '')) as HTMLElement[]

        howTargets.forEach(target => {
          const button = target.closest('button') as HTMLElement | null
          const link = target.closest('a') as HTMLElement | null
          const candidate = button || link || target

          if (candidate.querySelector('.trading-button')) {
            hideElement(target)
          } else {
            hideElement(candidate)
          }
        })
      })

      // Click the desired time range tab (default to 1D for better x-axis labels)
      const timeRange = options.timeRange || '6h'
      console.log(`📊 Selecting ${timeRange.toUpperCase()} time range...`)

      try {
        // Find and click the appropriate tab using Puppeteer's click
        const tabSelector = `button[role="tab"]`
        const tabs = await page.$$(tabSelector)

        for (const tab of tabs) {
          const text = await tab.evaluate(el => el.textContent?.trim().toLowerCase() || '')
          if (text === timeRange) {
            console.log(`✓ Clicking ${timeRange.toUpperCase()} tab...`)
            
            // Smart wait: Click and wait for network to settle (data fetch)
            // We expect a data fetch for the new time range
            await tab.evaluate(el => {
              ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
            })

            let clickMethod: 'puppeteer' | 'dom' = 'puppeteer'
            try {
              await tab.click({ delay: 20 })
            } catch (clickErr) {
              clickMethod = 'dom'
              console.log('⚠️ Puppeteer click failed, falling back to DOM click:', clickErr)
              await tab.evaluate(el => {
                ;(el as HTMLElement).click()
              })
            }

            await page
              .waitForNetworkIdle({ idleTime: 300, timeout: 4000 })
              .catch(() => console.log('⚠️ Network idle timeout after tab click'))

            console.log(`✓ Clicked ${timeRange.toUpperCase()} tab via ${clickMethod} and data loaded`)
            break
          }
        }
      } catch (err) {
        console.log('⚠️ Could not click time range tab:', err)
      }

       // After the time range updates, force all x-axis tick labels to render visibly.
       await page.evaluate(() => {
        // DEBUG: Log all tick information (serialize properly for console.log)
         const ticks = document.querySelectorAll('.visx-axis-tick')
         console.log('[DEBUG] Total .visx-axis-tick elements found:', ticks.length)
         
         ticks.forEach((tick, idx) => {
           const tickEl = tick as SVGGElement
           const text = tickEl.querySelector('text')
           const tspan = tickEl.querySelector('tspan')
           const textContent = tspan?.textContent || text?.textContent || 'NO TEXT'
           const opacity = tickEl.getAttribute('opacity') || window.getComputedStyle(tickEl).opacity
           const transform = tickEl.getAttribute('transform') || 'NO TRANSFORM'
           const fill = text?.getAttribute('fill') || 'NO FILL'
           const computedStyle = window.getComputedStyle(tickEl)
           
           console.log(`[DEBUG] Tick ${idx}: text="${textContent}", opacity=${opacity}, transform=${transform}, fill=${fill}, display=${computedStyle.display}, visibility=${computedStyle.visibility}`)
         })

         const chartSvg = document.querySelector('#group-chart-container svg') as SVGElement | null
         if (chartSvg) {
           chartSvg.style.overflow = 'visible'
           chartSvg.setAttribute('overflow', 'visible')
         }

         // Set the CSS variable to original Polymarket light gray (visible but not too dark)
         document.documentElement.style.setProperty('--neutral-200', '#9ca3af', 'important')
         
         // Target all text elements - keep original fill (var(--neutral-200)) but ensure visibility and larger size
         document.querySelectorAll('.visx-axis-tick text, .visx-axis-bottom text').forEach(text => {
           const el = text as SVGTextElement
           // Don't override fill - let it use var(--neutral-200) naturally
           el.setAttribute('opacity', '1')
           el.setAttribute('font-size', '13')
           el.setAttribute('font-weight', '500')
           el.style.opacity = '1'
           el.style.display = 'block'
           el.style.visibility = 'visible'
           el.style.fontSize = '13px'
           el.style.fontWeight = '500'
         })

         // Also target tspan elements - keep original fill
         document.querySelectorAll('.visx-axis-tick tspan').forEach(tspan => {
           const el = tspan as SVGTSpanElement
           // Don't override fill - let it inherit from parent text element
         })

        // Make Y-axis percentage labels larger
        document.querySelectorAll('.visx-axis-right text').forEach(text => {
          const el = text as SVGTextElement
          el.setAttribute('font-size', '14')
          el.setAttribute('font-weight', '500')
          el.style.fontSize = '14px'
          el.style.fontWeight = '500'
        })

         // Ensure the left-most x-axis time label (e.g. 4:00pm) doesn't get clipped.
         const xAxisTicks = Array.from(
           document.querySelectorAll('.visx-axis-bottom .visx-axis-tick')
         ) as SVGGElement[]
         const timeTicks = xAxisTicks.filter(tick => {
           const txt = tick.querySelector('tspan')?.textContent || ''
           return txt.includes('am') || txt.includes('pm')
         })
         if (timeTicks.length > 0) {
           const xs = timeTicks
             .map(t => parseFloat(t.querySelector('line')?.getAttribute('x1') || '0'))
             .filter(n => !Number.isNaN(n))
           const minX = Math.min(...xs)
           timeTicks.forEach(tick => {
             const x = parseFloat(tick.querySelector('line')?.getAttribute('x1') || '0')
             if (x === minX) {
               const text = tick.querySelector('text') as SVGTextElement | null
               if (text) {
                 text.setAttribute('text-anchor', 'start')
                 text.style.setProperty('transform', `translateX(${x + 6}px) translateY(12px)`)
               }
             }
           })
         }

         // Ensure tick groups are visible
         document.querySelectorAll('.visx-axis-tick, .visx-axis').forEach(tick => {
           const el = tick as SVGGElement
           el.setAttribute('opacity', '1')
           el.style.opacity = '1'
           el.style.display = 'block'
           el.style.visibility = 'visible'
         })

         // Ensure the nested SVG elements inside ticks allow overflow
         document.querySelectorAll('.visx-axis-tick > svg').forEach(svg => {
           const el = svg as SVGElement
           el.style.overflow = 'visible'
           el.setAttribute('overflow', 'visible')
         })

        // Re-apply chart watermark after time range updates (chart often re-renders)
        const findChartContainer = (): HTMLElement | null => {
          const byId = document.querySelector('#group-chart-container') as HTMLElement | null
          if (byId) return byId

          const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
          if (byTestId) return byTestId

          const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
          if (byClass) return byClass

          const byChartSvg = document.querySelector(
            '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
          ) as SVGElement | null
          if (byChartSvg) {
            return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
          }

          return null
        }

        const chartContainer = findChartContainer()
        const watermarkMode =
          (document.documentElement.getAttribute('data-chart-watermark') as ChartWatermarkMode | null) || 'none'
        if (watermarkMode !== 'none' && chartContainer) {
          const chartStyle = window.getComputedStyle(chartContainer)
          if (chartStyle.position === 'static') {
            chartContainer.style.setProperty('position', 'relative', 'important')
          }

          const existing = chartContainer.querySelector('#chart-watermark-overlay')
          if (existing) {
            existing.remove()
          }

          const overlay = document.createElement('div')
          overlay.id = 'chart-watermark-overlay'
          overlay.style.setProperty('position', 'absolute', 'important')
          overlay.style.setProperty('inset', '0', 'important')
          overlay.style.setProperty('display', 'flex', 'important')
          overlay.style.setProperty('align-items', 'center', 'important')
          overlay.style.setProperty('justify-content', 'center', 'important')
          overlay.style.setProperty('pointer-events', 'none', 'important')
          overlay.style.setProperty('z-index', '6', 'important')
          overlay.style.setProperty('opacity', '0.1', 'important')
          overlay.style.setProperty('transform', 'none', 'important')

          const buildWordmark = (): Node => {
            const logoSvg =
              (document.querySelector('div.ml-auto.self-end svg[viewBox="0 0 911 168"]') as SVGElement | null) ||
              (document.querySelector('svg[viewBox="0 0 911 168"]') as SVGElement | null)

            if (logoSvg) {
              const clone = logoSvg.cloneNode(true) as SVGElement
              clone.removeAttribute('height')
              clone.removeAttribute('width')
              clone.style.setProperty('height', '90px', 'important')
              clone.style.setProperty('width', 'auto', 'important')
              clone.style.setProperty('opacity', '1', 'important')
              clone.style.setProperty('color', '#9ca3af', 'important')
              return clone
            }

            const text = document.createElement('div')
            text.textContent = 'Polymarket'
            text.style.setProperty('font-size', '36px', 'important')
            text.style.setProperty('font-weight', '700', 'important')
            text.style.setProperty('color', '#9ca3af', 'important')
            return text
          }

          const buildIcon = (): Node => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            svg.setAttribute('viewBox', '0 0 137 165')
            svg.setAttribute('fill', 'none')
            svg.style.setProperty('height', '330px', 'important')
            svg.style.setProperty('width', '330px', 'important')
            svg.style.setProperty('opacity', '1', 'important')
            svg.style.setProperty('color', '#9ca3af', 'important')

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
            path.setAttribute(
              'd',
              'M136.267 152.495c0 7.265 0 10.897-2.376 12.697-2.375 1.801-5.872.82-12.867-1.143L8.632 132.51c-4.214-1.182-6.321-1.773-7.54-3.381-1.218-1.607-1.218-3.796-1.218-8.172V47.043c0-4.376 0-6.565 1.218-8.172 1.219-1.608 3.326-2.199 7.54-3.381L121.024 3.95c6.995-1.963 10.492-2.944 12.867-1.143s2.376 5.432 2.376 12.697zM27.904 122.228l93.062 26.117V96.113zm-12.73-12.117L108.217 84 15.174 57.889zm12.73-64.339 93.062 26.116V19.655z'
            )
            path.setAttribute('fill', 'currentColor')
            svg.appendChild(path)
            return svg
          }

          const node: Node = watermarkMode === 'icon' ? buildIcon() : buildWordmark()
          overlay.appendChild(node)

          chartContainer.appendChild(overlay)
        }
       })

      // Extra wait to ensure axis labels are fully rendered after manipulation
      // Reduced from 500ms - manipulation is synchronous, just need paint
      await new Promise(resolve => setTimeout(resolve, 50))

      // The time range click scrolls the chart into view.
      // Reset to top before final capture so title/header are included.
      await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null
        if (active && typeof active.blur === 'function') active.blur()
        window.scrollTo(0, 0)
      })
      await new Promise(resolve => setTimeout(resolve, 100))

      // Apply styling rules
      await styleOutcomeLegend(page)
      await styleBuyButtons(page, {
        showPotentialPayout: options.showPotentialPayout || false,
        payoutInvestment: options.payoutInvestment || 150
      })
      
      // Remove "How it works" after styling (it may have reappeared during DOM updates)
      await removeHowItWorks(page)

      // After adding payout text, ensure the volume row is still visible
      // The taller button container (when showing payout) can cover the volume row
      await page.evaluate(() => {
        const findChartContainer = (): HTMLElement | null => {
          const byId = document.querySelector('#group-chart-container') as HTMLElement | null
          if (byId) return byId
          const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
          if (byTestId) return byTestId
          const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
          if (byClass) return byClass
          const byChartSvg = document.querySelector(
            '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
          ) as SVGElement | null
          if (byChartSvg) {
            return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
          }
          return null
        }

        const chartContainer = findChartContainer()
        const volText = Array.from(document.querySelectorAll('p')).find(p =>
          ((p as HTMLElement).textContent || '').includes('Vol.')
        ) as HTMLElement | undefined
        const volRow =
          (volText?.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null) ||
          (volText?.closest('div.flex.w-full') as HTMLElement | null) ||
          (volText?.closest('div') as HTMLElement | null)

        const tradingButtonEl = document.querySelector('.trading-button') as HTMLElement | null
        let buyContainer: HTMLElement | null = null
        if (tradingButtonEl) {
          let el: HTMLElement | null = tradingButtonEl
          for (let i = 0; i < 12 && el; i++) {
            const style = window.getComputedStyle(el)
            if (style.position === 'fixed') {
              buyContainer = el
              break
            }
            el = el.parentElement as HTMLElement | null
          }
          buyContainer =
            buyContainer ||
            (tradingButtonEl.closest('nav') as HTMLElement | null) ||
            (tradingButtonEl.closest('div') as HTMLElement | null)
        }

        if (chartContainer && volRow && buyContainer) {
          const buffer = 16 // Increased buffer to ensure visibility
          const buyTop = buyContainer.getBoundingClientRect().top
          const volBottom = volRow.getBoundingClientRect().bottom
          if (volBottom >= buyTop - buffer) {
            const overlap = volBottom - (buyTop - buffer)
            const currentHeight = Math.round(chartContainer.getBoundingClientRect().height)
            const newHeight = Math.max(220, Math.round(currentHeight - overlap - 10)) // Extra margin
            console.log(`[VOL_ROW] Adjusting chart height from ${currentHeight}px to ${newHeight}px to show volume row`)
            chartContainer.style.setProperty('--chart-height', `${newHeight}px`, 'important')
            chartContainer.style.setProperty('height', `${newHeight}px`, 'important')
            chartContainer.style.setProperty('min-height', `${newHeight}px`, 'important')
            const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
            if (chartSvg) {
              chartSvg.setAttribute('height', `${newHeight}`)
              chartSvg.style.setProperty('height', `${newHeight}px`, 'important')
            }
          }
        }
      })

      // Node-side debug: ensure watermark exists right before screenshot
      if (chartWatermark !== 'none') {
        const hasWatermark = await page.$('#chart-watermark-overlay')
        console.log('🧩 Watermark overlay present before screenshot:', !!hasWatermark)
      }

      // Handle multi-outcome event pages:
      // - If a specific outcome URL was provided, filter the chart to just that outcome
      // - Otherwise, show all outcomes and add a generic Trade button
      if (nestedMarketSlug) {
        // Specific outcome URL: filter chart to single outcome, keep normal Yes/No buttons
        const filtered = await filterChartToSingleOutcome(page, nestedMarketSlug)
        if (filtered) {
          console.log('📊 Filtered chart to single outcome:', nestedMarketSlug)
          // Wait for chart to update after filtering
          await new Promise(resolve => setTimeout(resolve, 200))
          
          // For square aspect ratio, ensure we show ONLY the target outcome card (hide all others)
          // and fit it cleanly at the bottom of the viewport by adjusting chart height
          await page.evaluate((viewportHeight: number, targetSlug: string) => {
            const findChartContainer = (): HTMLElement | null => {
              const byId = document.querySelector('#group-chart-container') as HTMLElement | null
              if (byId) return byId
              const byTestId = document.querySelector('[data-testid="chart-container"]') as HTMLElement | null
              if (byTestId) return byTestId
              const byClass = document.querySelector('[class*="chart-container"]') as HTMLElement | null
              if (byClass) return byClass
              const byChartSvg = document.querySelector(
                '#group-chart-container svg, svg[class*="chart"], svg[class*="recharts"], svg[class*="visx"]'
              ) as SVGElement | null
              if (byChartSvg) {
                return (byChartSvg.closest('div') as HTMLElement | null) || (byChartSvg.parentElement as HTMLElement | null)
              }
              return null
            }

            // Find ALL outcome cards (each has group, border-b, py-4 classes and contains Buy Yes/No buttons)
            const findAllOutcomeCards = (): HTMLElement[] => {
              const cards: HTMLElement[] = []
              const allButtons = Array.from(document.querySelectorAll('button'))
              const buyButtons = allButtons.filter(btn => {
                const text = (btn.textContent || '').toLowerCase()
                const hasBuyText = text.includes('buy yes') || text.includes('buy no')
                const isNotTradingButton = !btn.classList.contains('trading-button')
                return hasBuyText && isNotTradingButton
              })
              
              for (const btn of buyButtons) {
                let parent: HTMLElement | null = btn
                for (let i = 0; i < 10 && parent; i++) {
                  parent = parent.parentElement as HTMLElement | null
                  if (!parent) break
                  const classes = parent.className || ''
                  if (classes.includes('group') && classes.includes('border-b') && classes.includes('py-4')) {
                    if (!cards.includes(parent)) {
                      cards.push(parent)
                    }
                    break
                  }
                }
              }
              
              return cards
            }

            const allCards = findAllOutcomeCards()
            console.log(`[NESTED_MARKET] Found ${allCards.length} outcome cards total`)
            console.log(`[NESTED_MARKET] Looking for target slug: ${targetSlug}`)
            
            // Find the target card by matching the slug in image URLs or card content
            let targetCard: HTMLElement | null = null
            
            for (const card of allCards) {
              // Method 1: Check if this card contains an image with our target slug in srcset/src
              const imgs = card.querySelectorAll('img')
              for (const img of imgs) {
                const srcset = img.getAttribute('srcset') || ''
                const src = img.getAttribute('src') || ''
                // Decode URL-encoded strings for matching
                const decodedSrcset = decodeURIComponent(srcset)
                const decodedSrc = decodeURIComponent(src)
                
                if (decodedSrcset.includes(targetSlug) || decodedSrc.includes(targetSlug) ||
                    srcset.includes(targetSlug) || src.includes(targetSlug)) {
                  targetCard = card
                  console.log('[NESTED_MARKET] Found target card via image src match')
                  break
                }
              }
              if (targetCard) break
              
              // Method 2: Check if the card's title matches keywords from the slug
              // e.g., slug "will-gavin-newsom-win..." should match card with title "Gavin Newsom"
              const titleEl = card.querySelector('p.font-semibold') as HTMLElement | null
              if (titleEl) {
                const title = (titleEl.textContent || '').toLowerCase().trim()
                // Convert slug to searchable keywords (e.g., "will-gavin-newsom-win" -> ["gavin", "newsom"])
                const slugWords = targetSlug.toLowerCase().split('-').filter(w => 
                  w.length > 3 && !['will', 'win', 'the', 'and', 'for'].includes(w)
                )
                // Check if most significant words from slug appear in the title
                const matchingWords = slugWords.filter(word => title.includes(word))
                if (matchingWords.length >= 2) {
                  targetCard = card
                  console.log(`[NESTED_MARKET] Found target card via title match: "${title}" matches [${matchingWords.join(', ')}]`)
                  break
                }
              }
            }
            
            // Fallback: if we have cards but couldn't match, log more details and use first one
            if (!targetCard && allCards.length > 0) {
              console.log('[NESTED_MARKET] Could not match target slug to any card')
              // Log what cards we have for debugging
              allCards.forEach((card, idx) => {
                const title = card.querySelector('p.font-semibold')?.textContent || 'Unknown'
                const img = card.querySelector('img')
                const src = img?.getAttribute('src') || 'No image'
                console.log(`[NESTED_MARKET] Card ${idx}: "${title}", src: ${src.substring(0, 80)}...`)
              })
              targetCard = allCards[0]
              console.log('[NESTED_MARKET] Using first card as target (fallback)')
            }
            
            if (!targetCard) {
              console.log('[NESTED_MARKET] No target outcome card found')
              return
            }
            
            // HIDE all other cards except the target
            let hiddenCount = 0
            for (const card of allCards) {
              if (card !== targetCard) {
                card.style.setProperty('display', 'none', 'important')
                hiddenCount++
              }
            }
            console.log(`[NESTED_MARKET] Hidden ${hiddenCount} non-target outcome cards`)
            
            // Also hide any content that appears AFTER the target card
            let sibling = targetCard.nextElementSibling as HTMLElement | null
            while (sibling) {
              sibling.style.setProperty('display', 'none', 'important')
              sibling = sibling.nextElementSibling as HTMLElement | null
            }
            
            // ENLARGE the target outcome card elements to make them more prominent
            // 1. Enlarge the market icon/image
            const marketImg = targetCard.querySelector('img[alt="Market icon"]') as HTMLImageElement | null
            if (marketImg) {
              const imgContainer = marketImg.closest('div.relative.rounded-sm.overflow-hidden') as HTMLElement | null
              if (imgContainer) {
                const newSize = '64px' // Up from 40px
                imgContainer.style.setProperty('width', newSize, 'important')
                imgContainer.style.setProperty('height', newSize, 'important')
                imgContainer.style.setProperty('min-width', newSize, 'important')
              }
            }
            
            // 2. Enlarge the title text (e.g., "Gavin Newsom")
            const titleEl = targetCard.querySelector('p.font-semibold') as HTMLElement | null
            if (titleEl) {
              titleEl.style.setProperty('font-size', '24px', 'important')
              titleEl.style.setProperty('line-height', '1.2', 'important')
            }
            
            // 3. Enlarge the percentage (e.g., "20%")
            const percentageEl = targetCard.querySelector('p.text-\\[28px\\]') as HTMLElement | null
              || targetCard.querySelector('p[class*="text-[28px]"]') as HTMLElement | null
            if (percentageEl) {
              percentageEl.style.setProperty('font-size', '40px', 'important')
              percentageEl.style.setProperty('line-height', '1.1', 'important')
            }
            
            // 4. Enlarge the volume text (e.g., "$3,582,706 Vol.")
            const volumeSpan = Array.from(targetCard.querySelectorAll('span')).find(span =>
              (span as HTMLElement).textContent?.includes('Vol.')
            ) as HTMLElement | null
            if (volumeSpan) {
              volumeSpan.style.setProperty('font-size', '15px', 'important')
            }
            
            // 5. Enlarge the Buy Yes/Buy No buttons
            const buyButtonsContainer = targetCard.querySelector('div.flex.justify-end.gap-3') as HTMLElement | null
            if (buyButtonsContainer) {
              const buttons = buyButtonsContainer.querySelectorAll('button')
              buttons.forEach(btn => {
                const button = btn as HTMLElement
                button.style.setProperty('height', '56px', 'important') // Up from h-11 (44px)
                button.style.setProperty('font-size', '18px', 'important')
                button.style.setProperty('font-weight', '600', 'important')
                button.style.setProperty('padding', '0 24px', 'important')
              })
            }
            
            // 6. Add more vertical padding to the card itself
            targetCard.style.setProperty('padding-top', '20px', 'important')
            targetCard.style.setProperty('padding-bottom', '20px', 'important')
            
            console.log('[NESTED_MARKET] Enlarged target card elements')
            
            // Force browser reflow before measuring by accessing offsetHeight
            targetCard.offsetHeight
            
            // Now adjust chart height to fit the enlarged target card cleanly
            const chartContainer = findChartContainer()
            if (!chartContainer) {
              console.log('[NESTED_MARKET] Chart container not found')
              return
            }
            
            // Re-measure after hiding other cards and enlarging the target
            const cardRect = targetCard.getBoundingClientRect()
            const cardBottom = cardRect.bottom
            const buffer = 8 // Small padding from bottom of viewport
            
            console.log(`[NESTED_MARKET] Target card bottom: ${Math.round(cardBottom)}, Viewport height: ${viewportHeight}`)
            
            if (cardBottom > viewportHeight - buffer) {
              // The card is cut off - we need to shrink the chart
              const overflow = cardBottom - (viewportHeight - buffer)
              const currentHeight = Math.round(chartContainer.getBoundingClientRect().height)
              // Shrink chart by the overflow amount plus small extra margin
              const newHeight = Math.max(160, Math.round(currentHeight - overflow - 8))
              
              console.log(`[NESTED_MARKET] Overflow: ${Math.round(overflow)}px, Reducing chart from ${currentHeight}px to ${newHeight}px`)
              
              chartContainer.style.setProperty('--chart-height', `${newHeight}px`, 'important')
              chartContainer.style.setProperty('height', `${newHeight}px`, 'important')
              chartContainer.style.setProperty('min-height', `${newHeight}px`, 'important')
              
              const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
              if (chartSvg) {
                chartSvg.setAttribute('height', `${newHeight}`)
                chartSvg.style.setProperty('height', `${newHeight}px`, 'important')
              }
            } else {
              console.log(`[NESTED_MARKET] Target card fits in viewport (bottom: ${Math.round(cardBottom)}, viewport: ${viewportHeight})`)
            }
          }, height, nestedMarketSlug) // Pass viewport height and target slug
          
          // Small wait for layout to settle after chart adjustment
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } else {
        // Event-only URL: show all outcomes with Trade button
        const isMultiOutcome = await cropToEventChart(page)
        if (isMultiOutcome) {
          console.log('📊 Multi-outcome event detected, added Trade button')
          // Small wait for the Trade button to render
          await new Promise(resolve => setTimeout(resolve, 50))

          // For square screenshots, we want the Trade button to be perfectly aligned below the content
          // without overlap. Since the button is fixed at bottom, we need to adjust the viewport height
          // to be exactly contentHeight + buttonHeight.
          const contentHeight = await measureEventChartHeight(page)
          if (contentHeight) {
            console.log(`📐 Adjusting square viewport height to ${contentHeight}px to fit Trade button`)
            await page.setViewport({
              width,
              height: contentHeight,
              deviceScaleFactor,
              isMobile: true,
              hasTouch: true
            })
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
      }

      // Final pass: remove any "How it works" elements that may have reappeared
      await removeHowItWorksSecondPass(page)
      
      console.log('📸 Taking viewport screenshot...')
      const screenshot = await page.screenshot({
        type: 'png'
      })

      const fileName = `polymarket-square-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

      console.log(`✅ Screenshot captured: ${fileName}`)

      return {
        success: true,
        screenshot: Buffer.from(screenshot),
        fileName,
        marketTitle: cleanTitle,
        url: cleanUrl
      }

    } catch (error) {
      console.error('❌ Error capturing Polymarket screenshot:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      await page.close()
    }
  }
}

// Export convenience function for one-off screenshots
export async function capturePolymarketSquareScreenshot(url: string): Promise<ScreenshotResult> {
  const service = new PolymarketSquareScreenshotService()
  
  try {
    await service.initialize()
    return await service.captureMarketScreenshot(url)
  } finally {
    await service.cleanup()
  }
}
