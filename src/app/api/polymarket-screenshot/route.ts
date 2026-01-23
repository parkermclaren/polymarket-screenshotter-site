import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { PolymarketScreenshotService, ScreenshotResult } from '@/polymarket-screenshotter/lib/polymarket-screenshot-service'
import type { PolymarketSquareScreenshotService } from '@/polymarket-screenshotter/lib/polymarket-square-screenshot-service'
import type { TemplateScreenshotService, TemplateScreenshotResult } from '@/polymarket-screenshotter/lib/template-screenshot-service'

export const maxDuration = 60 // Allow up to 60 seconds for screenshot capture
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

declare global {
  // eslint-disable-next-line no-var
  var __polymarketScreenshotService: any | undefined
  // eslint-disable-next-line no-var
  var __polymarketScreenshotServiceInit: Promise<any> | undefined
  // eslint-disable-next-line no-var
  var __polymarketScreenshotServiceVersion: string | undefined
  // eslint-disable-next-line no-var
  var __polymarketSquareScreenshotService: any | undefined
  // eslint-disable-next-line no-var
  var __polymarketSquareScreenshotServiceInit: Promise<any> | undefined
  // eslint-disable-next-line no-var
  var __polymarketSquareScreenshotServiceVersion: string | undefined
  // eslint-disable-next-line no-var
  var __polymarketScreenshotSemaphore:
    | { max: number; active: number; queue: Array<() => void> }
    | undefined
  // Template service globals
  // eslint-disable-next-line no-var
  var __templateScreenshotService: any | undefined
  // eslint-disable-next-line no-var
  var __templateScreenshotServiceInit: Promise<any> | undefined
  // eslint-disable-next-line no-var
  var __templateScreenshotServiceVersion: string | undefined
}

const isDevelopment = process.env.NODE_ENV === 'development'
const SERVICE_FILE_PATH = join(process.cwd(), 'src/polymarket-screenshotter/lib/polymarket-screenshot-service.ts')
const SQUARE_SERVICE_FILE_PATH = join(process.cwd(), 'src/polymarket-screenshotter/lib/polymarket-square-screenshot-service.ts')
const TEMPLATE_SERVICE_FILE_PATH = join(process.cwd(), 'src/polymarket-screenshotter/lib/template-screenshot-service.ts')
const RULES_DIR_PATH = join(process.cwd(), 'src/polymarket-screenshotter/lib/rules')
type ChartWatermarkMode = 'none' | 'wordmark' | 'icon'

function getRulesVersionTag(): string {
  if (!isDevelopment) return 'rules-v1'

  try {
    const files = readdirSync(RULES_DIR_PATH).filter(file => file.endsWith('.ts'))
    let maxMtime = 0
    const hash = createHash('md5')

    files.forEach(file => {
      const fullPath = join(RULES_DIR_PATH, file)
      const stats = statSync(fullPath)
      maxMtime = Math.max(maxMtime, stats.mtimeMs)
      hash.update(file)
      hash.update(String(stats.mtimeMs))
    })

    const digest = hash.digest('hex').slice(0, 8)
    return `rules-${maxMtime}-${digest}`
  } catch {
    return `rules-${Date.now()}`
  }
}

function normalizeChartWatermark(value: unknown): ChartWatermarkMode {
  if (value === 'icon') return 'icon'
  if (value === 'wordmark') return 'wordmark'
  if (value === true || value === 'true') return 'wordmark'
  return 'none'
}

/**
 * Get the service module, clearing cache in development for hot-reloading
 */
async function getServiceModule(): Promise<typeof import('@/polymarket-screenshotter/lib/polymarket-screenshot-service')> {
  if (isDevelopment) {
    // In development, clear the module cache to allow hot-reloading
    // Find and delete any cached modules related to the service file
    Object.keys(require.cache).forEach(key => {
      // Match both the source file and any compiled/transformed versions
      if (
        key.includes('polymarket-screenshot-service') ||
        key.includes('polymarket-screenshotter/lib')
      ) {
        delete require.cache[key]
      }
    })
  }
  
  // Dynamic import - Next.js will use the fresh module after cache clearing
  return await import('@/polymarket-screenshotter/lib/polymarket-screenshot-service')
}

async function getSquareServiceModule(): Promise<typeof import('@/polymarket-screenshotter/lib/polymarket-square-screenshot-service')> {
  if (isDevelopment) {
    Object.keys(require.cache).forEach(key => {
      if (
        key.includes('polymarket-square-screenshot-service') ||
        key.includes('polymarket-screenshotter/lib')
      ) {
        delete require.cache[key]
      }
    })
  }

  return await import('@/polymarket-screenshotter/lib/polymarket-square-screenshot-service')
}

/**
 * Get a version string based on file modification time (for development hot-reload)
 * or a static version (for production)
 */
function getServiceVersion(): string {
  if (isDevelopment) {
    try {
      // Use file modification time as version - changes when file is edited
      const stats = statSync(SERVICE_FILE_PATH)
      const mtime = stats.mtimeMs
      // Also hash a small portion of the file to catch content changes
      const content = readFileSync(SERVICE_FILE_PATH, 'utf-8').slice(0, 1000)
      const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
      const rulesTag = getRulesVersionTag()
      return `dev-${mtime}-${hash}-${rulesTag}`
    } catch {
      // Fallback if file doesn't exist or can't be read
      return `dev-${Date.now()}`
    }
  }
  return 'watermark-debug-1'
}

function getSquareServiceVersion(): string {
  if (isDevelopment) {
    try {
      const stats = statSync(SQUARE_SERVICE_FILE_PATH)
      const mtime = stats.mtimeMs
      const content = readFileSync(SQUARE_SERVICE_FILE_PATH, 'utf-8').slice(0, 1000)
      const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
      const rulesTag = getRulesVersionTag()
      return `dev-${mtime}-${hash}-${rulesTag}`
    } catch {
      return `dev-${Date.now()}`
    }
  }
  return 'square-v1'
}

async function getWarmService(): Promise<PolymarketScreenshotService> {
  const SCREENSHOT_SERVICE_VERSION = getServiceVersion()
  
  if (
    globalThis.__polymarketScreenshotService &&
    globalThis.__polymarketScreenshotServiceVersion === SCREENSHOT_SERVICE_VERSION
  ) {
    return globalThis.__polymarketScreenshotService
  }

  // Clear any existing init promise if version changed
  if (globalThis.__polymarketScreenshotServiceInit) {
    globalThis.__polymarketScreenshotServiceInit = undefined
  }

  if (!globalThis.__polymarketScreenshotServiceInit) {
    globalThis.__polymarketScreenshotServiceInit = (async () => {
      if (globalThis.__polymarketScreenshotService) {
        try {
          await globalThis.__polymarketScreenshotService.cleanup()
        } catch {}
      }
      
      // Get fresh module (will clear cache in development)
      const serviceModule = await getServiceModule()
      const PolymarketScreenshotService = serviceModule.PolymarketScreenshotService
      
      const service = new PolymarketScreenshotService()
      await service.initialize()
      globalThis.__polymarketScreenshotService = service
      globalThis.__polymarketScreenshotServiceVersion = SCREENSHOT_SERVICE_VERSION
      return service
    })()
  }

  return globalThis.__polymarketScreenshotServiceInit
}

async function getWarmSquareService(): Promise<PolymarketSquareScreenshotService> {
  const SQUARE_SERVICE_VERSION = getSquareServiceVersion()

  if (
    globalThis.__polymarketSquareScreenshotService &&
    globalThis.__polymarketSquareScreenshotServiceVersion === SQUARE_SERVICE_VERSION
  ) {
    return globalThis.__polymarketSquareScreenshotService
  }

  if (globalThis.__polymarketSquareScreenshotServiceInit) {
    globalThis.__polymarketSquareScreenshotServiceInit = undefined
  }

  if (!globalThis.__polymarketSquareScreenshotServiceInit) {
    globalThis.__polymarketSquareScreenshotServiceInit = (async () => {
      if (globalThis.__polymarketSquareScreenshotService) {
        try {
          await globalThis.__polymarketSquareScreenshotService.cleanup()
        } catch {}
      }

      const serviceModule = await getSquareServiceModule()
      const PolymarketSquareScreenshotService = serviceModule.PolymarketSquareScreenshotService

      const service = new PolymarketSquareScreenshotService()
      await service.initialize()
      globalThis.__polymarketSquareScreenshotService = service
      globalThis.__polymarketSquareScreenshotServiceVersion = SQUARE_SERVICE_VERSION
      return service
    })()
  }

  return globalThis.__polymarketSquareScreenshotServiceInit
}

/**
 * Get the template service module, clearing cache in development
 */
async function getTemplateServiceModule(): Promise<typeof import('@/polymarket-screenshotter/lib/template-screenshot-service')> {
  if (isDevelopment) {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('template-screenshot-service')) {
        delete require.cache[key]
      }
    })
  }
  return await import('@/polymarket-screenshotter/lib/template-screenshot-service')
}

/**
 * Get version for template service (for hot-reload)
 */
function getTemplateServiceVersion(): string {
  if (isDevelopment) {
    try {
      const stats = statSync(TEMPLATE_SERVICE_FILE_PATH)
      const mtime = stats.mtimeMs
      const content = readFileSync(TEMPLATE_SERVICE_FILE_PATH, 'utf-8').slice(0, 1000)
      const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
      return `dev-${mtime}-${hash}`
    } catch {
      return `dev-${Date.now()}`
    }
  }
  return 'template-v1'
}

async function getWarmTemplateService(): Promise<TemplateScreenshotService> {
  const TEMPLATE_SERVICE_VERSION = getTemplateServiceVersion()
  
  if (
    globalThis.__templateScreenshotService &&
    globalThis.__templateScreenshotServiceVersion === TEMPLATE_SERVICE_VERSION
  ) {
    return globalThis.__templateScreenshotService
  }

  if (globalThis.__templateScreenshotServiceInit) {
    globalThis.__templateScreenshotServiceInit = undefined
  }

  if (!globalThis.__templateScreenshotServiceInit) {
    globalThis.__templateScreenshotServiceInit = (async () => {
      if (globalThis.__templateScreenshotService) {
        try {
          await globalThis.__templateScreenshotService.cleanup()
        } catch {}
      }
      
      const serviceModule = await getTemplateServiceModule()
      const TemplateScreenshotService = serviceModule.TemplateScreenshotService
      
      const service = new TemplateScreenshotService()
      await service.initialize()
      globalThis.__templateScreenshotService = service
      globalThis.__templateScreenshotServiceVersion = TEMPLATE_SERVICE_VERSION
      return service
    })()
  }

  return globalThis.__templateScreenshotServiceInit
}

function getSemaphore() {
  if (!globalThis.__polymarketScreenshotSemaphore) {
    const max = Math.max(1, Number(process.env.SCREENSHOT_CONCURRENCY || 2))
    globalThis.__polymarketScreenshotSemaphore = { max, active: 0, queue: [] }
  }
  return globalThis.__polymarketScreenshotSemaphore
}

async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const sem = getSemaphore()

  if (sem.active >= sem.max) {
    await new Promise<void>(resolve => sem.queue.push(resolve))
  }

  sem.active += 1
  try {
    return await fn()
  } finally {
    sem.active -= 1
    sem.queue.shift()?.()
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { url, width, deviceScaleFactor, timeRange, chartWatermark, debugLayout, aspect } = body

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'Missing required "url" parameter' },
        { status: 400 }
      )
    }

    // Validate URL format
    if (!url.includes('polymarket.com')) {
      return NextResponse.json(
        { success: false, error: 'URL must be a polymarket.com URL' },
        { status: 400 }
      )
    }

    const resolvedAspect = aspect === 'square' ? 'square' : 'twitter'
    console.log(`📸 Starting Polymarket screenshot capture for: ${url} (${resolvedAspect})`)

    const service = resolvedAspect === 'square' ? await getWarmSquareService() : await getWarmService()

    const result: ScreenshotResult = await withSemaphore(() =>
      service.captureMarketScreenshot(url, {
        width: width || 700,
        deviceScaleFactor: deviceScaleFactor || 2,
        timeRange: timeRange || '6h', // Default to 6H for better x-axis labels
        chartWatermark: normalizeChartWatermark(chartWatermark),
        debugLayout: debugLayout === true,
      })
    )

    if (!result.success || !result.screenshot) {
      return NextResponse.json(
        { success: false, error: result.error || 'Screenshot capture failed' },
        { status: 500 }
      )
    }

    // Return the screenshot as a PNG image
    return new NextResponse(new Uint8Array(result.screenshot), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${result.fileName}"`,
        'X-Market-Title': encodeURIComponent(result.marketTitle || ''),
        'X-Market-URL': encodeURIComponent(result.url || ''),
      },
    })

  } catch (error) {
    console.error('❌ Polymarket screenshot API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

// GET endpoint to return screenshot as base64 JSON (useful for frontend preview)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')
  const width = searchParams.get('width')
  const timeRange = searchParams.get('timeRange') || '1d' // Default to 1D for better x-axis labels
  const aspect = searchParams.get('aspect') || 'twitter'
  const chartWatermark = normalizeChartWatermark(searchParams.get('chartWatermark'))
  const returnType = searchParams.get('return') || 'image' // 'image' or 'json'
  const debugLayout = searchParams.get('debugLayout') === '1' || searchParams.get('debugLayout') === 'true'
  const showPotentialPayout = searchParams.get('showPotentialPayout') === '1' || searchParams.get('showPotentialPayout') === 'true'
  const payoutInvestment = searchParams.get('payoutInvestment') ? parseInt(searchParams.get('payoutInvestment')!) : 150

  if (!url) {
    return NextResponse.json(
      { success: false, error: 'Missing required "url" query parameter' },
      { status: 400 }
    )
  }

  if (!url.includes('polymarket.com')) {
    return NextResponse.json(
      { success: false, error: 'URL must be a polymarket.com URL' },
      { status: 400 }
    )
  }

  const resolvedAspect = aspect === 'square' ? 'square' : 'twitter'
  console.log(`📸 Starting Polymarket screenshot capture for: ${url} (aspect: ${resolvedAspect})`)

  // Always use DOM manipulation mode
  const service = resolvedAspect === 'square' ? await getWarmSquareService() : await getWarmService()
  const result: ScreenshotResult = await withSemaphore(() =>
    service.captureMarketScreenshot(url, {
      width: width ? parseInt(width) : 700,
      deviceScaleFactor: 2,
      timeRange: timeRange as '1h' | '6h' | '1d' | '1w' | '1m' | 'max',
      chartWatermark,
      debugLayout,
      showPotentialPayout,
      payoutInvestment,
    })
  )

  if (!result.success || !result.screenshot) {
    return NextResponse.json(
      { success: false, error: result.error || 'Screenshot capture failed' },
      { status: 500 }
    )
  }

  if (returnType === 'json') {
    // Return as base64 JSON for frontend display
    return NextResponse.json({
      success: true,
      fileName: result.fileName,
      marketTitle: result.marketTitle,
      url: result.url,
      imageBase64: result.screenshot.toString('base64'),
      imageMimeType: 'image/png',
    })
  }

  // Return the screenshot as a PNG image
  return new NextResponse(new Uint8Array(result.screenshot), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="${result.fileName}"`,
      'X-Market-Title': encodeURIComponent(result.marketTitle || ''),
      'X-Market-URL': encodeURIComponent(result.url || ''),
      'Cache-Control': 'no-store, max-age=0',
    },
  })

}
