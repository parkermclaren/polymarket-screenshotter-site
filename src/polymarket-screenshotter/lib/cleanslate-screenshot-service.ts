import puppeteer, { Browser, Page } from 'puppeteer'

// Twitter optimal aspect ratio is 7:8 (width:height) for single image posts
const TWITTER_ASPECT_RATIO = 8 / 7

interface CleanSlateScreenshotOptions {
  width?: number
  deviceScaleFactor?: number
  timeRange?: '1h' | '6h' | '1d' | '1w' | '1m' | 'max'
}

export interface CleanSlateScreenshotResult {
  success: boolean
  screenshot?: Buffer
  fileName?: string
  error?: string
  marketTitle?: string
  url?: string
}

/**
 * Extracts the slug/path from a Polymarket URL
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
    
    const slug = pathMatch[2].split('/')[0]
    const cleanUrl = `https://polymarket.com/event/${slug}`
    
    return { valid: true, cleanUrl, slug }
  } catch {
    return { valid: false, cleanUrl: '', slug: '' }
  }
}

/**
 * Clean Slate screenshot service.
 * 
 * Instead of manipulating Polymarket's DOM in-place or scraping data to rebuild,
 * we create a fresh container and CLONE their actual rendered elements into it.
 * This gives us perfect visual fidelity (their CSS) with full layout control.
 */
export class CleanSlateScreenshotService {
  private browser: Browser | null = null

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Puppeteer for clean slate screenshots...')

    const isServerless = process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL || process.env.VERCEL_ENV
    const executablePath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim()

    if (isServerless || executablePath) {
      try {
        this.browser = await puppeteer.launch({
          headless: true,
          executablePath: executablePath || '/usr/bin/chromium-browser',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
          ],
          defaultViewport: null,
        })
      } catch (error) {
        console.error('❌ Clean slate screenshot service initialization failed:', error)
        throw new Error(`Clean slate screenshot service initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    } else {
      this.browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      })
    }

    console.log('✅ Browser initialized for clean slate screenshots')
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      console.log('🧹 Clean slate screenshot browser closed')
    }
  }

  /**
   * Wait for page to load
   */
  private async waitForPageLoad(page: Page): Promise<void> {
    try {
      await page.waitForSelector('h1', { timeout: 15000 })
    } catch {
      console.log('⚠️ Title not found')
    }

    try {
      await page.waitForSelector('.trading-button', { timeout: 10000 })
    } catch {
      console.log('⚠️ Trading buttons not found')
    }

    try {
      await page.waitForSelector('#group-chart-container svg', { timeout: 10000 })
    } catch {
      console.log('⚠️ Chart not found')
    }

    try {
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 3000 })
    } catch {
      // Continue if network doesn't settle
    }
  }

  /**
   * Capture a clean slate screenshot
   */
  async captureCleanSlateScreenshot(
    polymarketUrl: string,
    options: CleanSlateScreenshotOptions = {}
  ): Promise<CleanSlateScreenshotResult> {
    if (!this.browser) {
      return { success: false, error: 'Browser not initialized' }
    }

    const { valid, cleanUrl, slug } = parsePolymarketUrl(polymarketUrl)
    if (!valid) {
      return { success: false, error: 'Invalid Polymarket URL' }
    }

    const page = await this.browser.newPage()

    try {
      const width = options.width || 800
      const height = Math.round(width * TWITTER_ASPECT_RATIO)
      const deviceScaleFactor = options.deviceScaleFactor || 2
      const timeRange = options.timeRange || '1d'

      console.log(`📸 Clean slate screenshot: Loading ${cleanUrl}`)

      // Set up the page
      await page.setViewport({
        width: 1200,
        height: 1600,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      })

      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1')
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

      // Capture console logs for debugging
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('[CleanSlate]')) {
          console.log('🌐 Browser:', text)
        }
      })

      // Force light mode
      await page.evaluateOnNewDocument(() => {
        try {
          localStorage.setItem('theme', 'light')
          localStorage.setItem('color-theme', 'light')
        } catch {}
      })

      // Navigate
      await page.goto(cleanUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })

      await this.waitForPageLoad(page)

      const marketTitle = await page.title()
      const cleanTitle = marketTitle.replace(' Betting Odds & Predictions | Polymarket', '').trim()

      // Wait for buy buttons to exist (just check they exist, don't validate text)
      console.log('⏳ Waiting for Buy buttons...')
      try {
        await page.waitForSelector('.trading-button', { timeout: 15000 })
        await page.waitForFunction(
          () => {
            const buttons = document.querySelectorAll('.trading-button')
            return buttons.length >= 2
          },
          { timeout: 5000 }
        )
        console.log('✓ Buy buttons found')
      } catch (err) {
        console.log('⚠️ Buy buttons not found, continuing anyway')
      }

      // Click the time range tab
      console.log(`📊 Selecting ${timeRange.toUpperCase()} time range...`)
      try {
        const tabs = await page.$$('button[role="tab"]')
        for (const tab of tabs) {
          const text = await tab.evaluate(el => el.textContent?.trim().toLowerCase() || '')
          if (text === timeRange) {
            console.log(`✓ Clicking ${timeRange.toUpperCase()} tab...`)
            await tab.evaluate(el => (el as HTMLElement).scrollIntoView({ block: 'center' }))
            await new Promise(resolve => setTimeout(resolve, 100))
            
            try {
              await tab.click()
            } catch {
              // Fallback to DOM click
              await tab.evaluate(el => (el as HTMLElement).click())
            }
            
            await new Promise(resolve => setTimeout(resolve, 800)) // Wait for chart to update
            console.log(`✓ ${timeRange.toUpperCase()} tab clicked, chart updated`)
            break
          }
        }
      } catch (err) {
        console.log('⚠️ Could not click time range tab:', err)
      }

      // Now create our clean slate and clone elements into it
      console.log('🎨 Creating clean slate container...')
      
      await page.evaluate((targetWidth: number, targetHeight: number) => {
        console.log('[CleanSlate] Starting container creation')
        
        // Create the clean slate container
        const cleanSlate = document.createElement('div')
        cleanSlate.id = 'screenshot-clean-slate'
        cleanSlate.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: ${targetWidth}px;
          height: ${targetHeight}px;
          background: white;
          z-index: 999999;
          display: flex;
          flex-direction: column;
          padding: 20px 24px;
          font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          overflow: hidden;
        `

        // Clone the title
        const title = document.querySelector('h1');
        console.log('[CleanSlate] Title found:', !!title);
        const titleClone = title?.cloneNode(true) as HTMLElement | undefined;
        if (titleClone) {
          titleClone.style.cssText = `
            font-size: 28px;
            font-weight: 600;
            line-height: 1.2;
            margin: 0 0 12px 0;
            color: #1f2937;
          `;
          cleanSlate.appendChild(titleClone);
        }

        // Clone the probability section (including outcome label if present)
        // Look for the main probability display
        const findProbabilityContainer = () => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent?.trim() || '';
            if (text.match(/^\d+%\s*chance$/i)) {
              // Found it - return the parent container
              let el = node.parentElement;
              for (let i = 0; i < 5 && el; i++) {
                // Look for a flex container that groups the outcome label + probability + delta
                const style = window.getComputedStyle(el);
                if (style.display === 'flex' && el.children.length >= 1) {
                  return el;
                }
                el = el.parentElement;
              }
              return node.parentElement;
            }
          }
          return null;
        };

        const probContainer = findProbabilityContainer();
        console.log('[CleanSlate] Probability container found:', !!probContainer);
        if (probContainer) {
          const probClone = probContainer.cloneNode(true) as HTMLElement;
          probClone.style.cssText = `
            display: flex;
            flex-direction: column;
            margin-bottom: 8px;
          `;
          // Make sure all child elements have proper styling
          const probText = probClone.querySelector('*') as HTMLElement | null
          if (probText) {
            probText.style.fontSize = '32px'
            probText.style.fontWeight = '700'
            probText.style.color = '#22c55e'
          }
          cleanSlate.appendChild(probClone);
          console.log('[CleanSlate] Probability cloned successfully');
        }

        // Clone the chart container
        const chartContainer = document.querySelector('#group-chart-container')
        console.log('[CleanSlate] Chart container found:', !!chartContainer)
        if (chartContainer) {
          const chartClone = chartContainer.cloneNode(true) as HTMLElement
          chartClone.style.cssText = `
            flex: 1;
            min-height: 300px;
            margin-bottom: 12px;
            position: relative;
          `;
          // Ensure SVG fills the container
          const svg = chartClone.querySelector('svg');
          if (svg) {
            svg.style.width = '100%';
            svg.style.height = '100%';
          }
          cleanSlate.appendChild(chartClone);
          console.log('[CleanSlate] Chart cloned successfully');
        }

        // Clone the volume row (if it exists and volume > $50k)
        const volElements = Array.from(document.querySelectorAll('p, span, div'));
        const volEl = volElements.find(el => {
          const text = el.textContent?.trim() || '';
          return text.match(/^\$[\d,]+(?:\.\d+)?\s*Vol\.?$/i);
        });
        
        if (volEl) {
          const volText = volEl.textContent || '';
          const volMatch = volText.match(/\$([\d,]+)/);
          if (volMatch) {
            const volNum = parseInt(volMatch[1].replace(/,/g, ''));
            if (volNum >= 50000) {
              const volClone = volEl.cloneNode(true) as HTMLElement;
              volClone.style.cssText = `
                font-size: 18px;
                font-weight: 600;
                color: #1f2937;
                margin-bottom: 12px;
              `;
              cleanSlate.appendChild(volClone);
              console.log('[CleanSlate] Volume cloned successfully');
            }
          }
        }

        // Clone the trading buttons container - find the flex container that holds both buttons
        const firstButton = document.querySelector('.trading-button');
        console.log('[CleanSlate] First button found:', !!firstButton);
        
        let buttonsContainer: HTMLElement | null = null;
        if (firstButton) {
          // Walk up to find the container with class "flex" that contains both buttons
          let el: HTMLElement | null = firstButton as HTMLElement;
          for (let i = 0; i < 10 && el; i++) {
            const buttons = el.querySelectorAll('.trading-button');
            if (buttons.length >= 2) {
              buttonsContainer = el;
              console.log('[CleanSlate] Buttons container found at level', i, 'with', buttons.length, 'buttons');
              break;
            }
            el = el.parentElement as HTMLElement | null;
          }
        }
        
        if (buttonsContainer) {
          const buttonsClone = buttonsContainer.cloneNode(true) as HTMLElement;
          buttonsClone.style.cssText = `
            display: flex;
            gap: 16px;
            width: 100%;
          `;
          cleanSlate.appendChild(buttonsClone);
          console.log('[CleanSlate] Buttons cloned successfully');
        } else {
          console.log('[CleanSlate] WARNING: Buttons container not found!');
        }

        // Hide everything else and show only our clean slate
        document.body.appendChild(cleanSlate);
        document.querySelectorAll('body > *:not(#screenshot-clean-slate)').forEach(el => {
          (el as HTMLElement).style.display = 'none';
        });

        console.log('[CleanSlate] Container created and populated');
        
        // Debug: log what we actually added
        console.log('[CleanSlate] Children in clean slate:', cleanSlate.children.length);
        Array.from(cleanSlate.children).forEach((child, idx) => {
          console.log(`[CleanSlate]   ${idx}: ${child.tagName} ${child.className || '(no class)'}`);
        });
      }, width, height)

      // Wait for layout to settle
      await new Promise(resolve => setTimeout(resolve, 500))

      // Resize viewport to target dimensions
      await page.setViewport({
        width,
        height,
        deviceScaleFactor
      })

      await new Promise(resolve => setTimeout(resolve, 200))

      console.log('📸 Taking clean slate screenshot...')
      const screenshot = await page.screenshot({ type: 'png' })

      const fileName = `polymarket-cleanslate-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      console.log(`✅ Clean slate screenshot captured: ${fileName}`)

      return {
        success: true,
        screenshot: Buffer.from(screenshot),
        fileName,
        marketTitle: cleanTitle,
        url: cleanUrl
      }

    } catch (error) {
      console.error('❌ Error capturing clean slate screenshot:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      await page.close()
    }
  }
}

// Export convenience function
export async function captureCleanSlateScreenshot(url: string): Promise<CleanSlateScreenshotResult> {
  const service = new CleanSlateScreenshotService()
  
  try {
    await service.initialize()
    return await service.captureCleanSlateScreenshot(url)
  } finally {
    await service.cleanup()
  }
}
