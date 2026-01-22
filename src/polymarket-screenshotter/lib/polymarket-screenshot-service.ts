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
 */
function parsePolymarketUrl(url: string): { valid: boolean; cleanUrl: string; slug: string } {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes('polymarket.com')) {
      return { valid: false, cleanUrl: '', slug: '' }
    }
    
    const pathMatch = parsed.pathname.match(/^\/(event|market)\/(.+)/)
    if (!pathMatch) {
      return { valid: false, cleanUrl: '', slug: '' }
    }
    
    const slug = pathMatch[2].split('/')[0] // Get just the main slug, not subpaths
    const cleanUrl = `https://polymarket.com/event/${slug}`
    
    return { valid: true, cleanUrl, slug }
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

    const { valid, cleanUrl, slug } = parsePolymarketUrl(polymarketUrl)
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

      // Navigate to the page
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

      // FIRST: Wait for Buy buttons to exist before any DOM manipulation
      // Some markets are not Yes/No; they can be "Buy US" / "Buy Israel", etc.
      console.log('⏳ Waiting for Buy buttons to appear...')
      await page.waitForFunction(
        () => {
          const texts = Array.from(document.querySelectorAll('.trading-button-text'))
          const buyLabels = texts
            .map(t => (t.textContent || '').trim().toLowerCase())
            .filter(t => t.startsWith('buy '))
          return buyLabels.length >= 2
        },
        { timeout: 20000 }
      )
      console.log('✓ Buy buttons found')
      await this.waitForFonts(page)

      // DEBUG: Check what we actually have
      const debugInfo = await page.evaluate(() => {
        const tradingButtons = document.querySelectorAll('.trading-button')
        const buttonTexts = document.querySelectorAll('.trading-button-text')
        
        const info: Record<string, unknown> = {
          tradingButtonCount: tradingButtons.length,
          buttonTextCount: buttonTexts.length,
          buttonTexts: Array.from(buttonTexts).map(b => (b as HTMLElement).textContent?.trim()),
        }
        
        // Find the first trading button and trace its position
        if (tradingButtons.length > 0) {
          const btn = tradingButtons[0] as HTMLElement
          const rect = btn.getBoundingClientRect()
          const style = window.getComputedStyle(btn)
          
          info.firstButtonRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          info.firstButtonDisplay = style.display
          info.firstButtonVisibility = style.visibility
          
          // Check parents
          let parent = btn.parentElement
          let parentChain: string[] = []
          while (parent && parentChain.length < 10) {
            const ps = window.getComputedStyle(parent)
            parentChain.push(`${parent.tagName}.${parent.className?.split(' ')[0] || ''} (display:${ps.display}, position:${ps.position})`)
            if (ps.display === 'none') break
            parent = parent.parentElement
          }
          info.parentChain = parentChain
        }
        
        return info
      })
      console.log('🔍 DEBUG Buy buttons:', JSON.stringify(debugInfo, null, 2))

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
      await adjustHeightForDateChips(page)
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
      await styleBuyButtons(page)
      await adjustHeightForDateChips(page)
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

      console.log('📸 Taking viewport screenshot (should include fixed Buy bar at bottom)...')
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
