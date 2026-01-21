import { NextRequest, NextResponse } from 'next/server'
import { PolymarketScreenshotService } from '@/polymarket-screenshotter/lib/polymarket-screenshot-service'

export const maxDuration = 60 // Allow up to 60 seconds for screenshot capture
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { url, width, deviceScaleFactor, timeRange } = body

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

    console.log(`📸 Starting Polymarket screenshot capture for: ${url}`)

    const service = new PolymarketScreenshotService()
    
    try {
      await service.initialize()
      
      const result = await service.captureMarketScreenshot(url, {
        width: width || 700,
        deviceScaleFactor: deviceScaleFactor || 2,
        timeRange: timeRange || '6h' // Default to 6H for better x-axis labels
      })

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
          'X-Market-URL': encodeURIComponent(result.url || '')
        }
      })

    } finally {
      await service.cleanup()
    }

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
  const returnType = searchParams.get('return') || 'image' // 'image' or 'json'

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

  console.log(`📸 Starting Polymarket screenshot capture for: ${url}`)

  const service = new PolymarketScreenshotService()
  
  try {
    await service.initialize()
    
    const result = await service.captureMarketScreenshot(url, {
      width: width ? parseInt(width) : 700,
      deviceScaleFactor: 2,
      timeRange: timeRange as '1h' | '6h' | '1d' | '1w' | '1m' | 'max'
    })

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
        imageMimeType: 'image/png'
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
        'Cache-Control': 'no-store, max-age=0'
      }
    })

  } finally {
    await service.cleanup()
  }
}
