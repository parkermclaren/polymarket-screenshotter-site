import puppeteer, { Browser, Page } from 'puppeteer'

// Twitter optimal aspect ratio is 7:8 (width:height) for single image posts
const TWITTER_ASPECT_RATIO = 8 / 7

interface TemplateScreenshotOptions {
  width?: number
  deviceScaleFactor?: number
  timeRange?: '1h' | '6h' | '1d' | '1w' | '1m' | 'max'
}

export interface TemplateScreenshotResult {
  success: boolean
  screenshot?: Buffer
  fileName?: string
  error?: string
  marketTitle?: string
  url?: string
}

/**
 * Structured data extracted from a Polymarket page
 */
interface MarketData {
  title: string
  iconUrl: string | null
  probability: string // "66%" or "68% chance"
  probabilityLabel: string | null // Outcome name like "US" or "Yes" (null for simple yes/no markets)
  delta: { value: string; positive: boolean } | null // "+16%" change indicator
  volume: string | null // "$54,234 Vol."
  endDate: string | null // "Mar 31, 2026"
  buttons: Array<{ label: string; price: string; isYes: boolean }>
  chartSvgPath: string | null // The SVG path 'd' attribute for the chart line
  chartViewBox: { width: number; height: number } | null
  chartYAxisLabels: string[] // ["40%", "50%", "60%", ...]
  chartXAxisLabels: string[] // ["Jan 16", "Jan 19", ...]
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
 * Template-based screenshot service for Polymarket markets.
 * Instead of manipulating the DOM and screenshotting, we:
 * 1. Extract structured data from the page
 * 2. Render our own pixel-perfect template
 * 3. Screenshot our template
 * 
 * This is more robust because we control the layout entirely.
 */
export class TemplateScreenshotService {
  private browser: Browser | null = null

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Puppeteer for template screenshots...')

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
        console.error('❌ Template screenshot service initialization failed:', error)
        throw new Error(`Template screenshot service initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
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

    console.log('✅ Browser initialized for template screenshots')
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      console.log('🧹 Template screenshot browser closed')
    }
  }

  /**
   * Wait for page to load sufficiently for data extraction
   */
  private async waitForPageLoad(page: Page): Promise<void> {
    // Wait for the probability display to appear
    try {
      await page.waitForSelector('h1', { timeout: 15000 })
    } catch {
      console.log('⚠️ Title not found, continuing anyway')
    }

    // Wait for trading buttons
    try {
      await page.waitForSelector('.trading-button', { timeout: 10000 })
    } catch {
      console.log('⚠️ Trading buttons not found, continuing anyway')
    }

    // Wait for chart
    try {
      await page.waitForSelector('#group-chart-container svg path', { timeout: 10000 })
    } catch {
      console.log('⚠️ Chart not found, continuing anyway')
    }

    // Brief network settle
    try {
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 3000 })
    } catch {
      // Continue if network doesn't settle
    }
  }

  /**
   * Extract structured data from the Polymarket page
   */
  private async extractMarketData(page: Page, timeRange: string): Promise<MarketData> {
    // First, click the time range tab to get the right chart data
    try {
      const tabs = await page.$$('button[role="tab"]')
      for (const tab of tabs) {
        const text = await tab.evaluate(el => el.textContent?.trim().toLowerCase() || '')
        if (text === timeRange) {
          await tab.click()
          await new Promise(resolve => setTimeout(resolve, 800)) // Wait for chart to update
          break
        }
      }
    } catch (err) {
      console.log('⚠️ Could not click time range tab:', err)
    }

    const data = await page.evaluate(() => {
      // Extract title
      const titleEl = document.querySelector('h1')
      const title = titleEl?.textContent?.trim() || 'Unknown Market'

      // Extract market icon
      const iconImg = document.querySelector('img[alt="Market icon"]') as HTMLImageElement | null
      const iconUrl = iconImg?.src || null

      // Extract probability - look for elements containing "% chance"
      let probability = ''
      let probabilityLabel: string | null = null
      
      // Find all text nodes and look for the probability pattern
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      )
      
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent?.trim() || ''
        // Look for "XX% chance" pattern
        const match = text.match(/^(\d+)%\s*chance$/i)
        if (match) {
          probability = match[1] + '%'
          // Check if there's a label in a sibling or parent
          const parent = node.parentElement
          if (parent) {
            const grandparent = parent.parentElement
            if (grandparent) {
              // Look for a short label before this element
              const children = Array.from(grandparent.children)
              const idx = children.indexOf(parent)
              if (idx > 0) {
                const prev = children[idx - 1] as HTMLElement
                const prevText = prev.textContent?.trim() || ''
                if (prevText && prevText.length < 20 && !prevText.includes('%')) {
                  probabilityLabel = prevText
                }
              }
            }
          }
          break
        }
      }

      // Extract delta (change indicator) - look for triangle symbols or +/- percentages
      let delta: { value: string; positive: boolean } | null = null
      
      // Look for elements with green/red color that contain a percentage
      const allElements = document.querySelectorAll('span, div, p')
      for (const el of allElements) {
        const text = (el as HTMLElement).textContent?.trim() || ''
        const style = window.getComputedStyle(el as HTMLElement)
        const color = style.color
        
        // Check for percentage with optional sign
        const deltaMatch = text.match(/^[▲▼△▽↑↓+−-]?\s*(\d+(?:\.\d+)?)\s*%?$/i)
        if (deltaMatch && text.length < 10) {
          // Check if it's green (positive) or red (negative)
          const isGreen = color.includes('34, 197') || color.includes('22, 163') || color.includes('rgb(34') || text.includes('▲') || text.includes('↑') || text.includes('+')
          const isRed = color.includes('239, 68') || color.includes('220, 38') || text.includes('▼') || text.includes('↓') || text.includes('-') || text.includes('−')
          
          if (isGreen || isRed) {
            delta = {
              value: deltaMatch[1] + '%',
              positive: isGreen
            }
            break
          }
        }
      }

      // Extract volume - look for "$X Vol." pattern
      let volume: string | null = null
      const volElements = document.querySelectorAll('p, span, div')
      for (const el of volElements) {
        const text = (el as HTMLElement).textContent?.trim() || ''
        if (text.match(/^\$[\d,]+(?:\.\d+)?\s*Vol\.?$/i)) {
          volume = text
          break
        }
      }

      // Extract end date
      let endDate: string | null = null
      for (const el of volElements) {
        const text = (el as HTMLElement).textContent?.trim() || ''
        const dateMatch = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i)
        if (dateMatch) {
          endDate = text
          break
        }
      }

      // Extract buy buttons
      const buttons: Array<{ label: string; price: string; isYes: boolean }> = []
      const buttonTexts = document.querySelectorAll('.trading-button-text')
      buttonTexts.forEach(btn => {
        const text = (btn as HTMLElement).textContent?.trim() || ''
        // Parse "Buy US 66¢" or "Buy Yes 66¢"
        const match = text.match(/Buy\s+(.+?)\s+(\d+(?:\.\d+)?¢)/i)
        if (match) {
          const label = match[1]
          const price = match[2]
          const isYes = label.toLowerCase() === 'yes' || 
                        buttons.length === 0 // First button is typically the "yes" equivalent
          buttons.push({ label, price, isYes })
        }
      })

      // Extract chart data - get the SVG and its path
      let chartSvgPath: string | null = null
      let chartViewBox: { width: number; height: number } | null = null
      const chartXAxisLabels: string[] = []
      const chartYAxisLabels: string[] = []

      const chartContainer = document.querySelector('#group-chart-container')
      if (chartContainer) {
        // Find the main SVG with the chart
        const svgs = chartContainer.querySelectorAll('svg')
        let mainSvg: SVGElement | null = null
        
        // Find the SVG that contains the chart line (has visx classes)
        for (const svg of svgs) {
          if (svg.querySelector('.visx-linepath') || svg.querySelector('path[stroke]')) {
            mainSvg = svg
            break
          }
        }
        
        if (!mainSvg && svgs.length > 0) {
          mainSvg = svgs[0]
        }
        
        if (mainSvg) {
          // Get actual rendered dimensions
          const rect = mainSvg.getBoundingClientRect()
          chartViewBox = { width: rect.width, height: rect.height }

          // Find the main chart line path (visx-linepath class or path with stroke)
          const linePath = mainSvg.querySelector('.visx-linepath') as SVGPathElement | null
          if (linePath) {
            chartSvgPath = linePath.getAttribute('d')
          } else {
            // Fallback: find any path with a stroke
            const paths = mainSvg.querySelectorAll('path')
            for (const path of paths) {
              const stroke = path.getAttribute('stroke')
              const fill = path.getAttribute('fill')
              const d = path.getAttribute('d')
              // Chart line: has stroke, no fill (or transparent), and long path
              if (stroke && stroke !== 'none' && (!fill || fill === 'none' || fill === 'transparent') && d && d.length > 100) {
                chartSvgPath = d
                break
              }
            }
          }

          // Extract axis labels from visx
          const xAxisTicks = mainSvg.querySelectorAll('.visx-axis-bottom .visx-axis-tick text, .visx-axis-bottom .visx-axis-tick tspan')
          const yAxisTicks = mainSvg.querySelectorAll('.visx-axis-right .visx-axis-tick text, .visx-axis-right .visx-axis-tick tspan')
          
          xAxisTicks.forEach(tick => {
            const text = tick.textContent?.trim() || ''
            if (text && !chartXAxisLabels.includes(text)) {
              chartXAxisLabels.push(text)
            }
          })
          
          yAxisTicks.forEach(tick => {
            const text = tick.textContent?.trim() || ''
            if (text && !chartYAxisLabels.includes(text)) {
              chartYAxisLabels.push(text)
            }
          })
          
          // If we didn't find axis-specific labels, fall back to all ticks
          if (chartXAxisLabels.length === 0 && chartYAxisLabels.length === 0) {
            const allTicks = mainSvg.querySelectorAll('.visx-axis-tick text, .visx-axis-tick tspan')
            allTicks.forEach(tick => {
              const text = tick.textContent?.trim() || ''
              if (text) {
                if (text.includes('%')) {
                  if (!chartYAxisLabels.includes(text)) chartYAxisLabels.push(text)
                } else if (text.match(/\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|am|pm/i)) {
                  if (!chartXAxisLabels.includes(text)) chartXAxisLabels.push(text)
                }
              }
            })
          }
        }
      }

      console.log('[Template Extract]', {
        title,
        iconUrl: iconUrl?.slice(0, 50),
        probability,
        probabilityLabel,
        delta,
        volume,
        buttons: buttons.length,
        hasChart: !!chartSvgPath,
        chartViewBox,
        xLabels: chartXAxisLabels.length,
        yLabels: chartYAxisLabels.length
      })

      return {
        title,
        iconUrl,
        probability,
        probabilityLabel,
        delta,
        volume,
        endDate,
        buttons,
        chartSvgPath,
        chartViewBox,
        chartYAxisLabels,
        chartXAxisLabels,
      }
    })

    return data
  }

  /**
   * Generate HTML template that matches Polymarket's visual style
   */
  private generateTemplateHtml(data: MarketData, width: number, height: number): string {
    // Sort Y-axis labels by percentage value (descending)
    const sortedYLabels = [...data.chartYAxisLabels].sort((a, b) => {
      const aVal = parseInt(a.replace('%', ''))
      const bVal = parseInt(b.replace('%', ''))
      return bVal - aVal
    })

    // Generate button HTML - if no buttons extracted, show placeholder
    const buttonsHtml = data.buttons.length > 0 
      ? data.buttons.map((btn, idx) => {
          const bgColor = idx === 0 ? '#22c55e' : '#dc2626'
          return `
            <div style="
              flex: 1;
              background: ${bgColor};
              color: white;
              font-size: 18px;
              font-weight: 600;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 8px;
              height: 64px;
            ">
              Buy ${btn.label} ${btn.price}
            </div>
          `
        }).join('')
      : `
        <div style="flex: 1; background: #22c55e; color: white; font-size: 18px; font-weight: 600; display: flex; align-items: center; justify-content: center; border-radius: 8px; height: 64px;">
          Buy Yes
        </div>
        <div style="flex: 1; background: #dc2626; color: white; font-size: 18px; font-weight: 600; display: flex; align-items: center; justify-content: center; border-radius: 8px; height: 64px;">
          Buy No
        </div>
      `

    // Generate Y-axis labels HTML
    const yAxisHtml = sortedYLabels.length > 0 
      ? sortedYLabels.map(label => `
          <div style="color: #9ca3af; font-size: 13px; font-weight: 500;">${label}</div>
        `).join('')
      : ''

    // Generate X-axis labels HTML
    const xAxisHtml = data.chartXAxisLabels.length > 0
      ? data.chartXAxisLabels.map(label => `
          <div style="color: #9ca3af; font-size: 12px; font-weight: 500;">${label}</div>
        `).join('')
      : ''

    // Delta HTML
    const deltaHtml = data.delta ? `
      <span style="
        color: ${data.delta.positive ? '#22c55e' : '#dc2626'};
        font-size: 18px;
        font-weight: 500;
        margin-left: 8px;
      ">
        ${data.delta.positive ? '▲' : '▼'} ${data.delta.value}
      </span>
    ` : ''

    // Outcome label HTML (like "US" above the probability)
    const outcomeLabelHtml = data.probabilityLabel ? `
      <div style="
        color: #3b82f6;
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 2px;
      ">${data.probabilityLabel}</div>
    ` : ''

    // Chart SVG - use proper viewBox based on extracted dimensions
    const chartHeight = 380
    const vbWidth = data.chartViewBox?.width || 700
    const vbHeight = data.chartViewBox?.height || 280
    
    // Polymarket icon only (simpler, more reliable)
    const polymarketIconSvg = `
      <svg viewBox="0 0 137 165" fill="none" style="height: 22px; width: auto; color: #1f2937;">
        <path d="M136.267 152.495c0 7.265 0 10.897-2.376 12.697-2.375 1.801-5.872.82-12.867-1.143L8.632 132.51c-4.214-1.182-6.321-1.773-7.54-3.381-1.218-1.607-1.218-3.796-1.218-8.172V47.043c0-4.376 0-6.565 1.218-8.172 1.219-1.608 3.326-2.199 7.54-3.381L121.024 3.95c6.995-1.963 10.492-2.944 12.867-1.143s2.376 5.432 2.376 12.697zM27.904 122.228l93.062 26.117V96.113zm-12.73-12.117L108.217 84 15.174 57.889zm12.73-64.339 93.062 26.116V19.655z" fill="currentColor"/>
      </svg>
    `
    
    const chartSvgHtml = data.chartSvgPath ? `
      <svg 
        viewBox="0 0 ${vbWidth} ${vbHeight}"
        preserveAspectRatio="xMidYMid meet"
        style="width: 100%; height: 100%;"
      >
        <!-- Watermark -->
        <g opacity="0.08">
          <svg viewBox="0 0 137 165" x="${vbWidth/2 - 80}" y="${vbHeight/2 - 80}" width="160" height="160">
            <path 
              d="M136.267 152.495c0 7.265 0 10.897-2.376 12.697-2.375 1.801-5.872.82-12.867-1.143L8.632 132.51c-4.214-1.182-6.321-1.773-7.54-3.381-1.218-1.607-1.218-3.796-1.218-8.172V47.043c0-4.376 0-6.565 1.218-8.172 1.219-1.608 3.326-2.199 7.54-3.381L121.024 3.95c6.995-1.963 10.492-2.944 12.867-1.143s2.376 5.432 2.376 12.697zM27.904 122.228l93.062 26.117V96.113zm-12.73-12.117L108.217 84 15.174 57.889zm12.73-64.339 93.062 26.116V19.655z"
              fill="#9ca3af"
            />
          </svg>
        </g>
        <!-- Chart line -->
        <path 
          d="${data.chartSvgPath}" 
          stroke="#3b82f6" 
          stroke-width="2" 
          fill="none"
        />
      </svg>
    ` : '<div style="height: 100%; display: flex; align-items: center; justify-content: center; color: #9ca3af;">Chart not available</div>'

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: white;
          width: ${width}px;
          height: ${height}px;
          overflow: hidden;
        }
        .container {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          padding: 20px 24px;
        }
        .header {
          display: flex;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 12px;
        }
        .icon {
          width: 80px;
          height: 80px;
          border-radius: 8px;
          object-fit: cover;
          flex-shrink: 0;
        }
        .title {
          font-size: 28px;
          font-weight: 600;
          color: #1f2937;
          line-height: 1.2;
          flex: 1;
        }
        .probability-section {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .probability-left {
          display: flex;
          flex-direction: column;
        }
        .probability {
          font-size: 32px;
          font-weight: 700;
          color: #22c55e;
        }
        .probability-label {
          color: #3b82f6;
          font-size: 14px;
          font-weight: 600;
          text-transform: uppercase;
          margin-bottom: 2px;
        }
        .logo-container {
          display: flex;
          align-items: center;
        }
        .chart-section {
          flex: 1;
          display: flex;
          position: relative;
          margin-bottom: 8px;
        }
        .chart-container {
          flex: 1;
          position: relative;
        }
        .y-axis {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 10px 0;
          text-align: right;
          padding-right: 8px;
          width: 50px;
        }
        .x-axis {
          display: flex;
          justify-content: space-between;
          padding: 8px 50px 0 0;
        }
        .volume-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }
        .volume {
          font-size: 18px;
          font-weight: 600;
          color: #1f2937;
        }
        .time-tabs {
          display: flex;
          gap: 8px;
        }
        .time-tab {
          font-size: 16px;
          font-weight: 500;
          color: #6b7280;
          padding: 4px 8px;
        }
        .time-tab.active {
          color: #1f2937;
        }
        .buttons-row {
          display: flex;
          gap: 16px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header with icon and title -->
        <div class="header">
          ${data.iconUrl ? `<img class="icon" src="${data.iconUrl}" alt="Market icon" />` : ''}
          <h1 class="title">${data.title}</h1>
        </div>

        <!-- Probability and Logo row -->
        <div class="probability-section">
          <div class="probability-left">
            ${outcomeLabelHtml}
            <div style="display: flex; align-items: baseline;">
              <span class="probability">${data.probability || '?%'} chance</span>
              ${deltaHtml}
            </div>
          </div>
          <div class="logo-container" style="display: flex; align-items: center; gap: 6px;">
            ${polymarketIconSvg}
            <span style="font-size: 18px; font-weight: 600; color: #1f2937;">Polymarket</span>
          </div>
        </div>

        <!-- Chart with Y-axis -->
        <div class="chart-section">
          <div class="y-axis">
            ${yAxisHtml}
          </div>
          <div class="chart-container">
            ${chartSvgHtml}
          </div>
        </div>

        <!-- X-axis labels -->
        <div class="x-axis">
          ${xAxisHtml}
        </div>

        <!-- Volume row -->
        <div class="volume-row">
          <span class="volume">${data.volume || ''}</span>
          <div class="time-tabs">
            <span class="time-tab">1H</span>
            <span class="time-tab">6H</span>
            <span class="time-tab">1D</span>
            <span class="time-tab">1W</span>
            <span class="time-tab active">MAX</span>
          </div>
        </div>

        <!-- Buy buttons -->
        <div class="buttons-row">
          ${buttonsHtml}
        </div>
      </div>
    </body>
    </html>
    `

    return html
  }

  /**
   * Capture a template-based screenshot of a Polymarket market
   */
  async captureTemplateScreenshot(
    polymarketUrl: string,
    options: TemplateScreenshotOptions = {}
  ): Promise<TemplateScreenshotResult> {
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

      console.log(`📸 Template screenshot: Loading ${cleanUrl}`)

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

      // Navigate and wait for content
      await page.goto(cleanUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })

      await this.waitForPageLoad(page)

      // Extract data
      console.log('📊 Extracting market data...')
      const marketData = await this.extractMarketData(page, timeRange)
      console.log('✓ Data extracted:', {
        title: marketData.title,
        probability: marketData.probability,
        buttons: marketData.buttons.length,
        hasChart: !!marketData.chartSvgPath
      })

      // Generate our template HTML
      console.log('🎨 Generating template...')
      const templateHtml = this.generateTemplateHtml(marketData, width, height)

      // Render the template
      const templatePage = await this.browser!.newPage()
      await templatePage.setViewport({
        width,
        height,
        deviceScaleFactor
      })

      await templatePage.setContent(templateHtml, { waitUntil: 'networkidle0' })

      // Small wait for fonts to load
      await new Promise(resolve => setTimeout(resolve, 200))

      console.log('📸 Taking template screenshot...')
      const screenshot = await templatePage.screenshot({ type: 'png' })

      await templatePage.close()

      const fileName = `polymarket-template-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      console.log(`✅ Template screenshot captured: ${fileName}`)

      return {
        success: true,
        screenshot: Buffer.from(screenshot),
        fileName,
        marketTitle: marketData.title,
        url: cleanUrl
      }

    } catch (error) {
      console.error('❌ Error capturing template screenshot:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      await page.close()
    }
  }
}

// Export convenience function
export async function captureTemplateScreenshot(url: string): Promise<TemplateScreenshotResult> {
  const service = new TemplateScreenshotService()
  
  try {
    await service.initialize()
    return await service.captureTemplateScreenshot(url)
  } finally {
    await service.cleanup()
  }
}
