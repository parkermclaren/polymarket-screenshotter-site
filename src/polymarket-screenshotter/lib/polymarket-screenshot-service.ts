import puppeteer, { Browser, Page } from 'puppeteer'
import { adjustHeightForDateChips } from './rules/date-chips'
import { applyChartWatermark, type ChartWatermarkMode } from './rules/chart'
import { removeHowItWorks, removeHowItWorksSecondPass } from './rules/how-it-works'
import { styleVolumeRow } from './rules/volume-row'
import { styleHeader } from './rules/header-styling'
import { hideUnwantedElements } from './rules/hide-elements'
import { styleBuyButtons } from './rules/buy-buttons'
import { styleAxisLabels } from './rules/axis-labels'
import { applyDebugOverlay } from './rules/debug-overlay'
import { selectTimeRange } from './flows/time-range-selection'
import { styleOutcomeLegend } from './rules/outcome-legend'
import { cropToEventChart } from './rules/event-chart-crop'
import { filterChartToSingleOutcome } from './rules/single-outcome-filter'

// Twitter optimal aspect ratio is 7:8 (width:height) for single image posts
// This means for a given width, height = width * 8/7
const TWITTER_ASPECT_RATIO = 8 / 7

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

export class PolymarketScreenshotService {
  private browser: Browser | null = null

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Puppeteer for Polymarket screenshots...')

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
        console.error('❌ Screenshot service initialization failed:', error)
        throw new Error(`Screenshot service initialization failed in serverless environment: ${error instanceof Error ? error.message : 'Unknown error'}`)
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

    console.log('✅ Browser initialized for Polymarket screenshots')
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      console.log('🧹 Polymarket screenshot browser closed')
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
   * Compute a 7:8 crop region that guarantees the Buy Yes/Buy No buttons are included.
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
   * Capture a screenshot of a Polymarket market page optimized for Twitter (7:8 aspect ratio)
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
      // Twitter 7:8 aspect ratio settings
      // Using 700px width for good resolution, height = 700 * 8/7 = 800px
      // INCREASED to 800px to match wider mobile viewports that render more x-axis ticks
      const width = options.width || 800
      const height = Math.round(width * TWITTER_ASPECT_RATIO)
      const deviceScaleFactor = options.deviceScaleFactor || 2
      const debugLayout = options.debugLayout === true

      console.log(`📐 Setting viewport to ${width}x${height} (7:8 Twitter aspect ratio)`)

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
      
      // Store watermark mode for later retrieval
      await page.evaluate((mode: ChartWatermarkMode) => {
        document.documentElement.setAttribute('data-chart-watermark', mode)
        // FORCE LIGHT MODE
        document.documentElement.classList.remove('dark')
        document.documentElement.classList.add('light')
        document.documentElement.setAttribute('data-theme', 'light')
        document.documentElement.style.colorScheme = 'light'
        document.body.classList.remove('dark')
        document.body.classList.add('light')
      }, chartWatermark)
      
      // Apply all layout rules
      await hideUnwantedElements(page)
      await styleHeader(page)
      await styleOutcomeLegend(page)
      await adjustHeightForDateChips(page, { baseChartHeight: 400 })
      await applyChartWatermark(page, chartWatermark)

      // Let layout settle after DOM manipulation
      // Use a shorter wait, just enough for styles to apply
      await new Promise(resolve => setTimeout(resolve, 100))

      // Keep the larger viewport for now to capture more content
      // We'll clip to 7:8 aspect ratio after

      // Scroll to top so title is visible, then take viewport screenshot
      // Fixed elements (like the Buy button bar) will appear at bottom of viewport
      await page.evaluate(() => window.scrollTo(0, 0))
      await new Promise(resolve => setTimeout(resolve, 100))

      // Resize to our target 7:8 aspect ratio
      await page.setViewport({
        width,
        height,
        deviceScaleFactor,
        isMobile: true,
        hasTouch: true
      })
      // Small buffer for resize repaint
      await new Promise(resolve => setTimeout(resolve, 100))

      // Final cleanup pass
      await removeHowItWorks(page)
      await styleVolumeRow(page)
      await styleBuyButtons(page, {
        showPotentialPayout: options.showPotentialPayout || false,
        payoutInvestment: options.payoutInvestment || 150
      })
      await adjustHeightForDateChips(page, { baseChartHeight: 400 })
      await styleAxisLabels(page)
      if (debugLayout) {
        await applyDebugOverlay(page)
      }
      // Some runs inject the banner a beat later; do a short second pass.
      await new Promise(resolve => setTimeout(resolve, 200))
      await removeHowItWorksSecondPass(page)

      // Click the desired time range tab
      const timeRange = options.timeRange || '6h'
      await selectTimeRange(page, timeRange)

      // After time range updates, re-apply rules that may have been affected
      await styleAxisLabels(page)
      await applyChartWatermark(page, chartWatermark)

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
          
          // Hide all outcome cards except the target one (matching the nestedMarketSlug)
          await page.evaluate((targetSlug: string) => {
            // Helper function to find the chart container
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
            
            // Force browser reflow before measuring by accessing offsetHeight
            targetCard.offsetHeight
            
            console.log('[NESTED_MARKET] Enlarged target card elements')
            
            // Now adjust chart height to fit the enlarged target card cleanly (7:8 aspect ratio)
            const chartContainer = findChartContainer()
            if (!chartContainer) {
              console.log('[NESTED_MARKET] Chart container not found')
              return
            }
            
            // Re-measure after enlarging the target card
            const cardRect = targetCard.getBoundingClientRect()
            const cardBottom = cardRect.bottom
            const viewportHeight = window.innerHeight
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
          }, nestedMarketSlug)
          
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
        }
      }

      // NOTE: We do NOT resize the viewport for 7:8 screenshots based on content height.
      // The user prefers the fixed 7:8 aspect ratio even if there is whitespace.
      // The Trade button will be fixed at the bottom of the 7:8 viewport.

      console.log('📸 Taking viewport screenshot...')
      const screenshot = await page.screenshot({
        type: 'png'
      })

      const fileName = `polymarket-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

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
export async function capturePolymarketScreenshot(url: string): Promise<ScreenshotResult> {
  const service = new PolymarketScreenshotService()
  
  try {
    await service.initialize()
    return await service.captureMarketScreenshot(url)
  } finally {
    await service.cleanup()
  }
}
