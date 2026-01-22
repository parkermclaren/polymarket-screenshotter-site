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
 * Also detects nested markets within events (e.g. /event/election/will-jd-vance-win)
 */
function parsePolymarketUrl(url: string): { 
  valid: boolean
  cleanUrl: string
  slug: string
  marketSlug?: string
  targetUrl: string
} {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes('polymarket.com')) {
      return { valid: false, cleanUrl: '', slug: '', targetUrl: '' }
    }
    
    const pathMatch = parsed.pathname.match(/^\/(event|market)\/(.+)/)
    if (!pathMatch) {
      return { valid: false, cleanUrl: '', slug: '', targetUrl: '' }
    }
    
    const pathParts = pathMatch[2].split('/').filter(Boolean)
    const slug = pathParts[0] // Main event/market slug
    const marketSlug = pathParts.length > 1 ? pathParts.slice(1).join('/') : undefined // Nested market slug
    const cleanUrl = `https://polymarket.com/event/${slug}` // Parent event URL
    const targetUrl = marketSlug ? `https://polymarket.com/event/${slug}/${marketSlug}` : cleanUrl
    
    return { valid: true, cleanUrl, slug, marketSlug, targetUrl }
  } catch {
    return { valid: false, cleanUrl: '', slug: '', targetUrl: '' }
  }
}

/**
 * Formats a market slug into a proper title
 * E.g. "will-jd-vance-win-the-2028-us-presidential-election" → "Will JD Vance win the 2028 US Presidential Election?"
 */
function formatMarketTitleFromSlug(slug: string): string {
  // Remove trailing hash/ID (e.g. "-P-zEgXjCWbdY")
  const cleaned = slug.replace(/-[A-Z]-[a-zA-Z0-9]+$/, '')
  
  // Replace hyphens with spaces
  const words = cleaned.split('-').filter(Boolean)
  
  // Capitalize appropriately
  const formatted = words.map((word, idx) => {
    const lower = word.toLowerCase()
    // Keep acronyms uppercase
    if (lower === 'us' || lower === 'uk' || lower === 'eu' || lower === 'aoc') {
      return word.toUpperCase()
    }
    // Capitalize first word
    if (idx === 0) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    }
    // Keep numbers as-is
    if (/^\d+$/.test(word)) {
      return word
    }
    // Lowercase common words unless they're proper nouns
    if (['the', 'a', 'an', 'and', 'or', 'but', 'for', 'in', 'on', 'at', 'to', 'of'].includes(lower)) {
      return lower
    }
    // Check if it looks like a proper noun (all caps or mixed case)
    if (word === word.toUpperCase() || /[A-Z]/.test(word.slice(1))) {
      return word.charAt(0).toUpperCase() + word.slice(1)
    }
    return word.toLowerCase()
  }).join(' ')
  
  // Add question mark if it starts with a question word
  if (/^(will|would|should|could|can|is|are|does|do|did|has|have|had)\s/i.test(formatted)) {
    return formatted.endsWith('?') ? formatted : `${formatted}?`
  }
  
  return formatted
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
   * NESTED MARKET SUPPORT: Click into a specific market within an event page (mobile view).
   * 
   * On event pages with multiple markets (e.g. "Presidential Election Winner 2028"),
   * each candidate has a separate market. On mobile, these are shown as rows that you
   * can click to see the individual chart. This function finds and clicks that row.
   * 
   * @param page - Puppeteer page instance
   * @param marketSlug - The nested market slug (e.g. "will-jd-vance-win-the-2028-us-presidential-election")
   */
  private async clickIntoNestedMarket(page: Page, marketSlug: string): Promise<void> {
    console.log(`🎯 Clicking into nested market: ${marketSlug}`)
    
    // Capture browser console logs for debugging
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[NestedMarket]')) {
        console.log('🌐 Browser:', text)
      }
    })
    
    const clicked = await page.evaluate(async (slug: string) => {
      console.log('[NestedMarket] Searching for slug:', slug)
      
      // Scroll to bottom to trigger lazy loading of images
      console.log('[NestedMarket] Scrolling to trigger lazy loading...')
      window.scrollTo(0, document.body.scrollHeight)
      await new Promise(r => setTimeout(r, 500))
      window.scrollTo(0, 0)
      await new Promise(r => setTimeout(r, 200))

      // Strategy 1: Look for the specific container class structure provided by user
      // <div class="flex justify-between z-1"> containing the market info
      const containers = Array.from(document.querySelectorAll('div.flex.justify-between.z-1'))
      console.log('[NestedMarket] Found candidate containers:', containers.length)

      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const el = container as HTMLElement
        // Check for image with slug inside this container
        const img = el.querySelector('img')
        if (img) {
           const src = img.getAttribute('src') || ''
           const srcset = img.getAttribute('srcset') || ''
           console.log(`[NestedMarket] Container ${i}: src="${src.substring(0, 100)}...", srcset="${srcset.substring(0, 100)}..."`)
           if (src.includes(slug) || srcset.includes(slug)) {
             console.log('[NestedMarket] ✓ Found matching container via image!')
             el.scrollIntoView({ block: 'center', inline: 'center' })
             await new Promise(r => setTimeout(r, 100))
             el.click()
             console.log('[NestedMarket] ✓ Clicked container')
             return true
           }
        } else {
          console.log(`[NestedMarket] Container ${i}: No image found`)
        }
      }

      // Strategy 2: Find image with matching slug in src/srcset (Global search)
      console.log('[NestedMarket] Strategy 2: Searching all images globally...')
      const images = Array.from(document.querySelectorAll('img[src*="polymarket-upload"], img[srcset*="polymarket-upload"]'))
      console.log('[NestedMarket] Found', images.length, 'polymarket-upload images')
      
      const matchingImage = images.find(img => {
        const src = img.getAttribute('src') || ''
        const srcset = img.getAttribute('srcset') || ''
        return src.includes(slug) || srcset.includes(slug)
      })
      
      if (matchingImage) {
        console.log('[NestedMarket] ✓ Found matching image globally')
        // Walk up to find the clickable container
        let clickable: HTMLElement | null = matchingImage as HTMLElement
        for (let i = 0; i < 10 && clickable; i++) {
          clickable = clickable.parentElement as HTMLElement | null
          if (!clickable) break
          
          const classes = clickable.className || ''
          console.log(`[NestedMarket] Walking up level ${i}, classes: "${classes.substring(0, 80)}"`)
          // Match the container signature
          if (
            (classes.includes('flex') && classes.includes('justify-between')) ||
            classes.includes('z-1')
          ) {
            console.log('[NestedMarket] ✓ Found clickable parent container')
            clickable.scrollIntoView({ block: 'center', inline: 'center' })
            await new Promise(r => setTimeout(r, 100))
            clickable.click()
            console.log('[NestedMarket] ✓ Clicked via global image match')
            return true
          }
        }
        console.log('[NestedMarket] ✗ Could not find clickable parent for matching image')
      } else {
        console.log('[NestedMarket] ✗ No matching image found in', images.length, 'images')
      }
      
      // Strategy 3: Find link with matching href
      console.log('[NestedMarket] Strategy 3: Searching links...')
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
      console.log('[NestedMarket] Found', links.length, 'links')
      const matchingLink = links.find(a => (a.getAttribute('href') || '').includes(slug))
      if (matchingLink) {
        console.log('[NestedMarket] ✓ Found matching link')
        matchingLink.scrollIntoView({ block: 'center', inline: 'center' })
        await new Promise(r => setTimeout(r, 100))
        matchingLink.click()
        console.log('[NestedMarket] ✓ Clicked via link match')
        return true
      } else {
        console.log('[NestedMarket] ✗ No matching link found')
      }
      
      console.log('[NestedMarket] ✗ No matching element found for slug:', slug)
      return false
    }, marketSlug)
    
    if (!clicked) {
      console.log('⚠️ Could not find nested market to click')
      return
    }
    
    console.log('✓ Click executed, waiting for page navigation...')
    
    // Wait for the individual market page to load (chart + buy buttons)
    try {
      await page.waitForFunction(
        () => {
          // Check for buy buttons (individual market view)
          const buttons = document.querySelectorAll('.trading-button')
          return buttons.length >= 2
        },
        { timeout: 10000 }
      )
      console.log('✓ Nested market page loaded (buy buttons detected)')
      await this.waitForFonts(page)
    } catch (err) {
      console.log('⚠️ Buy buttons not detected after clicking nested market:', err instanceof Error ? err.message : 'Unknown error')
      // Check what we actually have
      const currentState = await page.evaluate(() => {
        return {
          tradingButtons: document.querySelectorAll('.trading-button').length,
          url: window.location.href,
          title: document.querySelector('h1')?.textContent || 'No title'
        }
      })
      console.log('📊 Current page state:', JSON.stringify(currentState, null, 2))
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

    const { valid, cleanUrl, slug, marketSlug, targetUrl } = parsePolymarketUrl(polymarketUrl)
    if (!valid) {
      return { success: false, error: 'Invalid Polymarket URL. Please provide a valid polymarket.com/event/... or polymarket.com/market/... URL' }
    }

    // NESTED MARKET SUPPORT: If a nested market slug exists, we'll format a proper title from it
    const isNestedMarket = !!marketSlug
    const titleOverride = isNestedMarket ? formatMarketTitleFromSlug(marketSlug) : null

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
      if (isNestedMarket) {
        console.log(`🎯 This is a nested market, will click into: ${marketSlug}`)
      }

      // Capture browser console logs for debugging
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('[DEBUG]') || text.includes('[NestedMarket]')) {
          console.log('🌐 Browser:', text)
        }
      })

      // Navigate to the parent event page (or direct market if not nested)
      // NESTED MARKET SUPPORT: Try navigating directly to the nested market URL first.
      // This is often more reliable than clicking. If it redirects to the parent, we'll handle that.
      const urlToLoad = isNestedMarket ? targetUrl : cleanUrl
      console.log(`🚀 Loading URL: ${urlToLoad}`)
      
      await page.goto(urlToLoad, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })

      // Wait for page to fully load
      await this.waitForPageLoad(page)
      await this.waitForFonts(page)

      // NESTED MARKET SUPPORT: Click into the specific market if this is a nested market
      if (isNestedMarket && marketSlug) {
        // Check if we are already on the nested market page (e.g. single chart vs group chart)
        // If the page has multiple market rows (event page), we need to click.
        const isEventPage = await page.evaluate(() => {
          const imageCount = document.querySelectorAll('img[src*="polymarket-upload"]').length
          const tradingButtons = document.querySelectorAll('.trading-button').length
          return {
            imageCount,
            tradingButtons,
            isEventPage: imageCount > 5,
            url: window.location.href,
            title: document.querySelector('h1')?.textContent || 'No title'
          }
        })
        
        console.log('📊 Page state after navigation:', JSON.stringify(isEventPage, null, 2))

        if (isEventPage.isEventPage) {
          console.log('ℹ️ Landed on event page (multiple markets detected), attempting to click into nested market...')
          await this.clickIntoNestedMarket(page, marketSlug)
          // Give the new page a moment to settle
          await this.waitForFonts(page)
          
          // Verify we're now on the individual market page
          const afterClickState = await page.evaluate(() => {
            return {
              tradingButtons: document.querySelectorAll('.trading-button').length,
              url: window.location.href,
              title: document.querySelector('h1')?.textContent || 'No title',
              chartExists: !!document.querySelector('#group-chart-container')
            }
          })
          console.log('📊 Page state after click:', JSON.stringify(afterClickState, null, 2))
        } else {
          console.log('✓ Appears to be on nested market page already (single market detected)')
        }
        
        // Verify buy buttons now exist after clicking in
        console.log('⏳ Verifying buy buttons appeared after clicking into nested market...')
        try {
          await page.waitForFunction(
            () => {
              const texts = Array.from(document.querySelectorAll('.trading-button-text'))
              const buyLabels = texts
                .map(t => (t.textContent || '').trim().toLowerCase())
                .filter(t => t.startsWith('buy '))
              return buyLabels.length >= 2
            },
            { timeout: 8000 }
          )
          console.log('✓ Buy buttons found after nested market click')
        } catch {
          return {
            success: false,
            error: `Could not find buy buttons after clicking into nested market "${marketSlug}". The market may not exist or failed to load.`
          }
        }
      }

      // Get the page title for metadata
      const marketTitle = await page.title()
      const cleanTitle = titleOverride || marketTitle.replace(' Betting Odds & Predictions | Polymarket', '').trim()

      // FIRST: Wait for Buy buttons to exist before any DOM manipulation
      // Some markets are not Yes/No; they can be "Buy US" / "Buy Israel", etc.
      // NOTE: For nested markets, buy buttons won't exist yet (they appear after clicking in)
      if (!isNestedMarket) {
        console.log('⏳ Waiting for Buy buttons to appear...')
        try {
          await page.waitForFunction(
            () => {
              const texts = Array.from(document.querySelectorAll('.trading-button-text'))
              const buyLabels = texts
                .map(t => (t.textContent || '').trim().toLowerCase())
                .filter(t => t.startsWith('buy '))
              return buyLabels.length >= 2
            },
            { timeout: 8000 }
          )
          console.log('✓ Buy buttons found')
        } catch {
          console.log('⚠️ Buy buttons not found - may be a multi-market event page')
          return {
            success: false,
            error: 'This appears to be a multi-market event page. Please use a direct market URL or provide a specific market within the event (e.g., /event/election/candidate-name).'
          }
        }
      } else {
        console.log('ℹ️ Nested market detected - buy buttons will appear after clicking in')
      }
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
      await page.evaluate((mode: ChartWatermarkMode, titleText: string | null) => {
        document.documentElement.setAttribute('data-chart-watermark', mode)
        // FORCE LIGHT MODE
        document.documentElement.classList.remove('dark')
        document.documentElement.classList.add('light')
        document.documentElement.setAttribute('data-theme', 'light')
        document.documentElement.style.colorScheme = 'light'
        document.body.classList.remove('dark')
        document.body.classList.add('light')

        // NESTED MARKET SUPPORT: Override title text if provided (e.g. "Will JD Vance win?" instead of "JD Vance")
        if (titleText) {
          const title = document.querySelector('h1') as HTMLElement | null
          if (title) {
            title.textContent = titleText
            console.log('[DEBUG] Title overridden to:', titleText)
          }
        }
      }, chartWatermark, titleOverride)
      
      // Apply all layout rules
      await hideUnwantedElements(page)
      await styleHeader(page)
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

      console.log('📸 Taking viewport screenshot (should include fixed Buy bar at bottom)...')
      const screenshot = await page.screenshot({
        type: 'png'
      })

      // Use the nested market slug for filename if available (more specific)
      const fileSlug = marketSlug || slug
      const fileName = `polymarket-${fileSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

      console.log(`✅ Screenshot captured: ${fileName}`)

      return {
        success: true,
        screenshot: Buffer.from(screenshot),
        fileName,
        marketTitle: cleanTitle,
        url: targetUrl // Use the target URL (nested market URL if applicable)
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
