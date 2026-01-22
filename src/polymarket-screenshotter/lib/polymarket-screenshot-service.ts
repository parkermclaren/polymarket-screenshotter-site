import puppeteer, { Browser, Page } from 'puppeteer'

// Twitter optimal aspect ratio is 7:8 (width:height) for single image posts
// This means for a given width, height = width * 8/7
const TWITTER_ASPECT_RATIO = 8 / 7

type ChartWatermarkMode = 'none' | 'wordmark' | 'icon'

interface ScreenshotOptions {
  width?: number
  height?: number
  deviceScaleFactor?: number
  timeRange?: '1h' | '6h' | '1d' | '1w' | '1m' | 'max' // Chart time range, defaults to '1d'
  chartWatermark?: ChartWatermarkMode | boolean // Watermark mode; boolean true maps to 'wordmark'
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
          // Increase chart height from default 272px to 400px
          const newChartHeight = '400px'
          chartContainer.style.setProperty('--chart-height', newChartHeight, 'important')
          chartContainer.style.setProperty('height', newChartHeight, 'important')
          chartContainer.style.setProperty('min-height', newChartHeight, 'important')

          // Also resize the SVG inside the chart container
          const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
          if (chartSvg) {
            chartSvg.setAttribute('height', '400')
            chartSvg.style.setProperty('height', '400px', 'important')
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

        // Make Buy buttons taller/thicker to fill more of their section
        document.querySelectorAll('.trading-button').forEach(btn => {
          const button = btn as HTMLElement
          button.style.setProperty('height', '72px', 'important')
          button.style.setProperty('min-height', '72px', 'important')
          button.style.setProperty('padding-top', '20px', 'important')
          button.style.setProperty('padding-bottom', '20px', 'important')
        })

        // Also increase the span wrapper height
        document.querySelectorAll('.trading-button').forEach(btn => {
          const parent = btn.parentElement as HTMLElement | null
          if (parent && parent.tagName === 'SPAN') {
            parent.style.setProperty('height', '72px', 'important')
          }
        })

        // Also style the button text to be slightly larger
        document.querySelectorAll('.trading-button-text').forEach(text => {
          const el = text as HTMLElement
          el.style.setProperty('font-size', '18px', 'important')
          el.style.setProperty('font-weight', '600', 'important')
        })

        // Ensure Buy Yes / Buy No cents sum to 100.0 by adjusting Buy No rounding.
        const yesTextEl = Array.from(document.querySelectorAll('.trading-button-text')).find(el =>
          (el as HTMLElement).textContent?.trim().toLowerCase().startsWith('buy yes')
        ) as HTMLElement | undefined
        const noTextEl = Array.from(document.querySelectorAll('.trading-button-text')).find(el =>
          (el as HTMLElement).textContent?.trim().toLowerCase().startsWith('buy no')
        ) as HTMLElement | undefined

        const parseCents = (text: string): number | null => {
          const match = text.match(/([0-9]+(?:\.[0-9]+)?)¢/)
          if (!match) return null
          const value = Number(match[1])
          return Number.isNaN(value) ? null : value
        }

        const formatCents = (value: number): string => value.toFixed(1)

        if (yesTextEl && noTextEl) {
          const yesText = yesTextEl.textContent || ''
          const noText = noTextEl.textContent || ''
          const yesValue = parseCents(yesText)
          const noValue = parseCents(noText)

          if (yesValue !== null && noValue !== null) {
            const adjustedNo = Math.max(0, 100 - yesValue)
            const updatedNoText = noText.replace(/([0-9]+(?:\.[0-9]+)?)¢/, `${formatCents(adjustedNo)}¢`)
            noTextEl.textContent = updatedNoText
          }
        }

        // Add padding below the buttons container
        // Find the container div that holds the trading buttons (it's a div, not nav)
        const tradingButton = document.querySelector('.trading-button')
        if (tradingButton) {
          // Walk up to find the main container div (has h-20, bg-background classes)
          let container: HTMLElement | null = tradingButton as HTMLElement
          for (let i = 0; i < 10 && container; i++) {
            container = container.parentElement as HTMLElement | null
            if (!container) break
            const classes = container.className || ''
            // The main container has h-20 and bg-background
            if (classes.includes('h-20') || classes.includes('bg-background')) {
              container.style.setProperty('padding-top', '20px', 'important')
              container.style.setProperty('padding-bottom', '16px', 'important')
              container.style.setProperty('height', 'auto', 'important')
              container.style.setProperty('min-height', '100px', 'important')
              break
            }
          }
        }

        // PRODUCTION SAFETY: Ensure the Buy buttons container is visible and fixed at the bottom.
        // In some layouts, our cleanup can accidentally hide parts of the fixed nav.
        const btn = document.querySelector('.trading-button') as HTMLElement | null
        if (btn) {
          const fixedAncestor = (() => {
            let el: HTMLElement | null = btn
            for (let i = 0; i < 12 && el; i++) {
              const style = window.getComputedStyle(el)
              if (style.position === 'fixed') return el
              el = el.parentElement as HTMLElement | null
            }
            return null
          })()

          const container = fixedAncestor || (btn.closest('nav') as HTMLElement | null)
          if (container) {
            container.style.setProperty('display', 'flex', 'important')
            container.style.setProperty('visibility', 'visible', 'important')
            container.style.setProperty('opacity', '1', 'important')
            container.style.setProperty('position', 'fixed', 'important')
            container.style.setProperty('left', '0', 'important')
            container.style.setProperty('right', '0', 'important')
            container.style.setProperty('bottom', '0', 'important')
            container.style.setProperty('z-index', '99999', 'important')
          }
        }
      })
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
