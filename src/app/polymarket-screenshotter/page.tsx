'use client'

import { useState, useCallback, useEffect, useRef } from 'react'

interface ScreenshotResult {
  success: boolean
  fileName?: string
  marketTitle?: string
  url?: string
  imageBase64?: string
  imageMimeType?: string
  error?: string
  ogImage?: {
    fileName?: string
    imageBase64?: string
    imageMimeType?: string
  }
}

export default function PolymarketScreenshotterPage() {
  const [url, setUrl] = useState('')
  const [imageType, setImageType] = useState<'screenshot' | 'og'>('screenshot')
  const [timeRange, setTimeRange] = useState<'1h' | '6h' | '1d' | '1w' | '1m' | 'max'>('1d')
  const [chartWatermark, setChartWatermark] = useState<'none' | 'wordmark' | 'icon'>('none')
  const [chartLineThickness, setChartLineThickness] = useState<'normal' | 'thick'>('normal')
  const [aspect, setAspect] = useState<'twitter' | 'square'>('twitter')
  const [debugLayout, setDebugLayout] = useState(false)
  const [showPotentialPayout, setShowPotentialPayout] = useState(false)
  const [payoutInvestment, setPayoutInvestment] = useState(150)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScreenshotResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // OG image editor state
  const [leftSideImage, setLeftSideImage] = useState<string | null>(null)
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0, scale: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [isResizing, setIsResizing] = useState(false)
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, scale: 1 })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [ogAspectRatio, setOgAspectRatio] = useState<string>('1200 / 630')
  const [ogPixelSize, setOgPixelSize] = useState<{ width: number; height: number } | null>(null)

  // OG Image Editor handlers - defined early so they can be used in useEffect
  const handleFileSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      setLeftSideImage(dataUrl)

      // Default behavior: DO NOT crop on paste. Start by fitting the entire image into the left half.
      // Cropping only happens when the user zooms in or drags.
      const img = new Image()
      img.onload = () => {
        const ogW = ogPixelSize?.width || 0
        const ogH = ogPixelSize?.height || 0
        const leftHalfW = ogW > 0 ? ogW / 2 : 0
        const leftHalfH = ogH

        const iw = img.naturalWidth || 0
        const ih = img.naturalHeight || 0

        let fitScale = 1
        if (leftHalfW > 0 && leftHalfH > 0 && iw > 0 && ih > 0) {
          fitScale = Math.min(leftHalfW / iw, leftHalfH / ih)
        }

        setCropPosition({ x: 0, y: 0, scale: fitScale })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [ogPixelSize])

  // Derive OG aspect ratio from the returned OG image so the crop frame matches the pixels.
  useEffect(() => {
    if (!result?.ogImage?.imageBase64) return

    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (w && h) {
        setOgAspectRatio(`${w} / ${h}`)
        setOgPixelSize({ width: w, height: h })
      }
    }
    img.src = `data:${result.ogImage.imageMimeType || 'image/png'};base64,${result.ogImage.imageBase64}`
  }, [result?.ogImage?.imageBase64, result?.ogImage?.imageMimeType])

  // Global paste handler for OG image editor
  useEffect(() => {
    if (!result?.ogImage) return

    const handlePasteGlobal = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault()
          const file = items[i].getAsFile()
          if (file) {
            handleFileSelect(file)
          }
          break
        }
      }
    }

    window.addEventListener('paste', handlePasteGlobal)
    return () => {
      window.removeEventListener('paste', handlePasteGlobal)
    }
  }, [result?.ogImage, handleFileSelect])

  const handleCapture = useCallback(async () => {
    if (!url.trim()) {
      setError('Please enter a Polymarket URL')
      return
    }

    if (!url.includes('polymarket.com')) {
      setError('Please enter a valid Polymarket URL')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      if (imageType === 'og') {
        // Fetch OG image only
        const ogParams = new URLSearchParams({
          url,
          return: 'json',
          imageType: 'og'
        })

        const ogResponse = await fetch(`/api/polymarket-screenshot?${ogParams.toString()}`)
        const ogData = await ogResponse.json()

        if (!ogData.success) {
          setError(ogData.error || 'OG image fetch failed')
          return
        }

        setResult({
          success: true,
          ogImage: {
            fileName: ogData.fileName,
            imageBase64: ogData.imageBase64,
            imageMimeType: ogData.imageMimeType
          }
        })
      } else {
        // Fetch screenshot only
        const screenshotParams = new URLSearchParams({
          url,
          timeRange,
          return: 'json',
          imageType: 'screenshot',
          ...(chartWatermark !== 'none' && { chartWatermark }),
          ...(chartLineThickness === 'thick' && { chartLineThickness }),
          ...(debugLayout && { debugLayout: '1' }),
          ...(aspect === 'square' && { aspect: 'square' }),
          ...(showPotentialPayout && { showPotentialPayout: '1' }),
          ...(showPotentialPayout && payoutInvestment && { payoutInvestment: payoutInvestment.toString() })
        })

        const screenshotResponse = await fetch(`/api/polymarket-screenshot?${screenshotParams.toString()}`)
        const screenshotData = await screenshotResponse.json()

        if (!screenshotData.success) {
          setError(screenshotData.error || 'Screenshot capture failed')
          return
        }

        setResult(screenshotData)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [url, imageType, timeRange, chartWatermark, chartLineThickness, debugLayout, aspect, showPotentialPayout, payoutInvestment])

  const handleDownload = useCallback(() => {
    if (!result?.imageBase64 || !result?.fileName) return

    const link = document.createElement('a')
    const mime = result.imageMimeType || 'image/png'
    link.href = `data:${mime};base64,${result.imageBase64}`
    link.download = result.fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [result])

  const handleCopyToClipboard = useCallback(async () => {
    if (!result?.imageBase64) return

    try {
      // Convert base64 to blob
      const mime = result.imageMimeType || 'image/png'
      const response = await fetch(`data:${mime};base64,${result.imageBase64}`)
      const blob = await response.blob()
      
      await navigator.clipboard.write([
        new ClipboardItem({ [mime]: blob })
      ])
      
      // Show brief feedback
      const button = document.getElementById('copy-btn')
      if (button) {
        const originalText = button.textContent
        button.textContent = 'Copied!'
        setTimeout(() => {
          button.textContent = originalText
        }, 2000)
      }
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      setError('Failed to copy to clipboard. Try downloading instead.')
    }
  }, [result])

  const handleCopyOGToClipboard = useCallback(async () => {
    if (!result?.ogImage?.imageBase64) return

    try {
      // Convert base64 to blob
      const mime = result.ogImage.imageMimeType || 'image/png'
      const response = await fetch(`data:${mime};base64,${result.ogImage.imageBase64}`)
      const blob = await response.blob()
      
      await navigator.clipboard.write([
        new ClipboardItem({ [mime]: blob })
      ])
      
      // Show brief feedback
      const button = document.getElementById('copy-og-btn')
      if (button) {
        const originalText = button.textContent
        button.textContent = 'Copied!'
        setTimeout(() => {
          button.textContent = originalText
        }, 2000)
      }
    } catch (err) {
      console.error('Failed to copy OG image to clipboard:', err)
      setError('Failed to copy OG image to clipboard. Try downloading instead.')
    }
  }, [result])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleCapture()
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) {
      handleFileSelect(file)
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) {
          handleFileSelect(file)
        }
        break
      }
    }
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!leftSideImage) return
    setIsDragging(true)
    setDragStart({ x: e.clientX - cropPosition.x, y: e.clientY - cropPosition.y })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!leftSideImage) return

    if (isResizing) {
      const dx = e.clientX - resizeStart.x
      const dy = e.clientY - resizeStart.y
      const delta = (dx + dy) / 200
      const nextScale = Math.max(0.1, Math.min(10, resizeStart.scale + delta))
      setCropPosition(prev => ({
        ...prev,
        scale: nextScale,
      }))
      return
    }

    if (isDragging) {
      setCropPosition(prev => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      }))
    }
  }

  const handleMouseUp = () => {
    setIsDragging(false)
    setIsResizing(false)
  }

  const handleWheel = (e: React.WheelEvent) => {
    if (!leftSideImage) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setCropPosition(prev => ({
      ...prev,
      scale: Math.max(0.1, Math.min(10, prev.scale * delta)),
    }))
  }

  const handleResizeMouseDown = (_corner: 'nw' | 'ne' | 'se' | 'sw') => (e: React.MouseEvent) => {
    if (!leftSideImage) return
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    setResizeStart({ x: e.clientX, y: e.clientY, scale: cropPosition.scale })
  }

  const handleExportOGImage = async () => {
    if (!result?.ogImage?.imageBase64 || !leftSideImage) return

    try {
      // Create canvas to composite images
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Load the OG image (right half with blank left)
      const ogImg = new Image()
      ogImg.src = `data:${result.ogImage.imageMimeType || 'image/png'};base64,${result.ogImage.imageBase64}`
      
      await new Promise((resolve) => {
        ogImg.onload = resolve
      })

      canvas.width = ogImg.width
      canvas.height = ogImg.height

      // Draw the OG image (includes blank left half)
      ctx.drawImage(ogImg, 0, 0)

      // Load and draw the left side image
      const leftImg = new Image()
      leftImg.src = leftSideImage
      
      await new Promise((resolve) => {
        leftImg.onload = resolve
      })

      const leftHalfWidth = canvas.width / 2
      const leftHalfHeight = canvas.height

      // Get the preview container and the preview image element to match positioning exactly
      const previewContainer = document.querySelector('.og-editor-container') as HTMLElement
      const previewImageContainer = previewContainer?.querySelector('.og-preview-image-container') as HTMLElement
      
      if (!previewContainer || !previewImageContainer) {
        setError('Could not find preview containers')
        return
      }

      const containerRect = previewImageContainer.getBoundingClientRect()
      
      // CRITICAL: The preview overlay image uses `inset-0` which makes it fill the ENTIRE container,
      // then object-contain fits it to the FULL width/height. We only show the left half via clipPath.
      const previewFullWidth = containerRect.width
      const previewFullHeight = containerRect.height

      // Get the actual source image dimensions
      const sourceImgWidth = leftImg.naturalWidth
      const sourceImgHeight = leftImg.naturalHeight

      // Calculate object-contain scale using FULL container dimensions
      const sourceAspect = sourceImgWidth / sourceImgHeight
      const containerAspect = previewFullWidth / previewFullHeight
      
      let objectContainScale: number
      
      if (sourceAspect > containerAspect) {
        // Image is wider - limited by container width
        objectContainScale = previewFullWidth / sourceImgWidth
      } else {
        // Image is taller - limited by container height
        objectContainScale = previewFullHeight / sourceImgHeight
      }

      // Calculate displayed size (object-contain scale × user scale)
      const baseDisplayedWidth = sourceImgWidth * objectContainScale
      const baseDisplayedHeight = sourceImgHeight * objectContainScale
      const displayedWidth = baseDisplayedWidth * cropPosition.scale
      const displayedHeight = baseDisplayedHeight * cropPosition.scale

      // The image transform is centered in the FULL container, not the left half
      const centerX = previewFullWidth / 2
      const centerY = previewFullHeight / 2
      const previewX = centerX - (displayedWidth / 2) + cropPosition.x
      const previewY = centerY - (displayedHeight / 2) + cropPosition.y

      // Convert from preview CSS pixels to canvas pixels using FULL width ratio
      const cssToCanvasRatio = canvas.width / previewFullWidth
      const canvasX = previewX * cssToCanvasRatio
      const canvasY = previewY * cssToCanvasRatio
      const canvasWidth = displayedWidth * cssToCanvasRatio
      const canvasHeight = displayedHeight * cssToCanvasRatio

      // Draw the left side image with clipping to left half
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, leftHalfWidth, leftHalfHeight)
      ctx.clip()
      ctx.drawImage(leftImg, canvasX, canvasY, canvasWidth, canvasHeight)
      ctx.restore()

      // Convert to blob and download
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = result.ogImage?.fileName?.replace('.png', '-composite.png') || 'polymarket-og-composite.png'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      }, 'image/png')
    } catch (err) {
      console.error('Error exporting composite image:', err)
      setError('Failed to export composite image')
    }
  }

  return (
    <div className="min-h-screen bg-[#f7f7f8] text-gray-900">
      {/* Top bar (Polymarket-ish) */}
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gray-900 text-white">
              <span className="text-sm font-semibold">P</span>
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-gray-900">Polymarket</div>
              <div className="text-xs text-gray-500">Screenshotter</div>
            </div>
          </div>

        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Capture a market screenshot</h1>
          <p className="mt-1 text-sm text-gray-600">
            Paste a Polymarket market URL and generate a clean <span className="font-medium text-gray-900">7:8</span> or <span className="font-medium text-gray-900">1:1</span> image.
          </p>
        </div>

        {/* Input */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          {/* Image Type Toggle */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Image Type
            </label>
            <div className="flex gap-3">
              <label className="flex-1 cursor-pointer">
                <input
                  type="radio"
                  name="imageType"
                  value="screenshot"
                  checked={imageType === 'screenshot'}
                  onChange={(e) => setImageType(e.target.value as 'screenshot' | 'og')}
                  disabled={loading}
                  className="sr-only"
                />
                <div className={`rounded-xl border-2 px-4 py-3 text-center text-sm font-semibold transition-colors ${
                  imageType === 'screenshot'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                }`}>
                  Screenshot
                </div>
              </label>
              <label className="flex-1 cursor-pointer">
                <input
                  type="radio"
                  name="imageType"
                  value="og"
                  checked={imageType === 'og'}
                  onChange={(e) => setImageType(e.target.value as 'screenshot' | 'og')}
                  disabled={loading}
                  className="sr-only"
                />
                <div className={`rounded-xl border-2 px-4 py-3 text-center text-sm font-semibold transition-colors ${
                  imageType === 'og'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                }`}>
                  OG Image
                </div>
              </label>
            </div>
          </div>

          {/* Market URL - Full width */}
          <div className="mb-4">
            <label htmlFor="url-input" className="block text-sm font-medium text-gray-900 mb-2">
              Market URL
            </label>
            <input
              id="url-input"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="https://polymarket.com/event/..."
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
              disabled={loading}
            />
          </div>

          {/* Options - Only show for screenshots */}
          {imageType === 'screenshot' && (
          <div className="flex flex-wrap items-end gap-6">
            {/* Time Range */}
            <div className="flex-shrink-0">
              <label className="block text-sm font-medium text-gray-900 mb-2">
                Time Range
              </label>
              <div className="flex flex-wrap gap-2">
                {(['1h', '6h', '1d', '1w', '1m', 'max'] as const).map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    disabled={loading}
                    className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                      timeRange === range
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {range.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Aspect Ratio */}
            <div className="flex-shrink-0 border-l border-gray-200 pl-6">
              <label className="block text-sm font-medium text-gray-900 mb-2">
                Aspect Ratio
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAspect('twitter')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    aspect === 'twitter'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  7:8
                </button>
                <button
                  type="button"
                  onClick={() => setAspect('square')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    aspect === 'square'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  1:1
                </button>
              </div>
            </div>

            {/* Chart Line */}
            <div className="flex-shrink-0 border-l border-gray-200 pl-6">
              <label className="block text-sm font-medium text-gray-900 mb-2">
                Line
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setChartLineThickness('normal')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    chartLineThickness === 'normal'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Normal
                </button>
                <button
                  type="button"
                  onClick={() => setChartLineThickness('thick')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    chartLineThickness === 'thick'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Thick
                </button>
              </div>
            </div>

            {/* Chart Watermark */}
            <div className="flex-shrink-0 border-l border-gray-200 pl-6">
              <label className="block text-sm font-medium text-gray-900 mb-2">
                Watermark
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setChartWatermark('none')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    chartWatermark === 'none'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={() => setChartWatermark('wordmark')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    chartWatermark === 'wordmark'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Wordmark
                </button>
                <button
                  type="button"
                  onClick={() => setChartWatermark('icon')}
                  disabled={loading}
                  className={`rounded-lg border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    chartWatermark === 'icon'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Icon
                </button>
              </div>
            </div>
          </div>
          )}

          {/* Secondary Options Row - Only show for screenshots */}
          {imageType === 'screenshot' && (
          <div className="mt-4 flex flex-wrap items-end gap-4">
            {/* Payout Display */}
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showPotentialPayout}
                  onChange={(e) => setShowPotentialPayout(e.target.checked)}
                  disabled={loading}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-900">Show payout</span>
              </label>
            </div>

            {/* Investment Amount (conditional) */}
            {showPotentialPayout && (
              <div className="flex-1 sm:flex-initial sm:w-32">
                <label htmlFor="payout-investment" className="sr-only">
                  Investment Amount
                </label>
                <input
                  id="payout-investment"
                  type="number"
                  value={payoutInvestment}
                  onChange={(e) => setPayoutInvestment(parseInt(e.target.value) || 150)}
                  disabled={loading}
                  min="1"
                  max="10000"
                  placeholder="150"
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
                />
              </div>
            )}

            {/* Debug Layout - Only show in development */}
            {process.env.NODE_ENV === 'development' && (
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={debugLayout}
                    onChange={(e) => setDebugLayout(e.target.checked)}
                    disabled={loading}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-900">Debug overlay</span>
                </label>
              </div>
            )}

            {/* Capture Button */}
            <div className="ml-auto">
              <button
                onClick={handleCapture}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {loading ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Capturing…
                  </>
                ) : (
                  'Capture'
                )}
              </button>
            </div>
          </div>
          )}

          <p className="mt-4 text-xs text-gray-500">Tip: hit <span className="font-medium text-gray-900">Enter</span> to capture.</p>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Result */}
        {result && (
          <div className="mt-8 space-y-8">
            {/* Screenshot Section */}
            {result.imageBase64 && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {/* Preview (left) */}
              <div className="lg:col-span-8">
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-col gap-1 mb-4">
                    <h2 className="text-base font-semibold text-gray-900">Screenshot</h2>
                    {result.url && (
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 hover:text-blue-500"
                      >
                        {result.url}
                      </a>
                    )}
                  </div>

                  <div className="mt-5 flex justify-center">
                    <div className="relative w-full max-w-[420px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                      <div style={{ aspectRatio: aspect === 'square' ? '1 / 1' : '7 / 8' }}>
                        <img
                          src={`data:${result.imageMimeType || 'image/png'};base64,${result.imageBase64}`}
                          alt={result.marketTitle || 'Polymarket screenshot'}
                          className="h-full w-full object-contain bg-white"
                        />
                      </div>
                      <div className="absolute bottom-3 right-3 rounded-lg border border-gray-200 bg-white/90 px-2 py-1 text-xs text-gray-600 shadow-sm backdrop-blur">
                        {aspect === 'square' ? '1:1' : '7:8'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 text-xs text-gray-500">
                    File: <span className="font-medium text-gray-900">{result.fileName}</span>
                  </div>
                </div>
              </div>

              {/* Actions (right) */}
              <div className="lg:col-span-4">
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="text-sm font-semibold text-gray-900">Actions</div>
                    <div className="text-xs text-gray-500">Export</div>
                  </div>

                  <div className="grid gap-3">
                    <button
                      id="copy-btn"
                      onClick={handleCopyToClipboard}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900 shadow-sm transition-colors hover:bg-gray-50"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                        />
                      </svg>
                      Copy to clipboard
                    </button>

                    <button
                      onClick={handleDownload}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download
                    </button>
                  </div>

                  <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
                    Best for Twitter single-image posts. If you need a different crop or theme, tell me what you want to match.
                  </div>
                </div>
              </div>
            </div>
            )}

            {/* OG Image Section */}
            {result.ogImage?.imageBase64 && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                {/* Preview (left) */}
                <div className="lg:col-span-8">
                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-col gap-1 mb-4">
                      <h2 className="text-base font-semibold text-gray-900">OG Image</h2>
                      <p className="text-sm text-gray-600">OpenGraph image for social sharing</p>
                    </div>

                  <div className="mt-5">
                    <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                      <p className="font-medium text-gray-900 mb-1">Interactive Editor</p>
                      <p>Drag & drop an image, or paste (Ctrl/Cmd+V) to add to the left side. Drag to reposition, scroll to zoom.</p>
                    </div>
                    <div
                      className="og-editor-container relative w-full overflow-hidden rounded-2xl border-2 border-dashed border-gray-300 bg-white"
                      onDrop={handleDrop}
                      onDragOver={(e) => e.preventDefault()}
                      onPaste={handlePaste}
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseUp}
                      onWheel={handleWheel}
                      style={{ cursor: leftSideImage ? (isResizing ? 'nwse-resize' : isDragging ? 'grabbing' : 'grab') : 'default' }}
                    >
                      <div className="og-preview-image-container relative" style={{ aspectRatio: ogAspectRatio }}>
                        {/* OG image (right half visible, left is transparent/blank) */}
                        <img
                          src={`data:${result.ogImage.imageMimeType || 'image/png'};base64,${result.ogImage.imageBase64}`}
                          alt={result.marketTitle || 'Polymarket OG image'}
                          className="relative h-full w-full object-cover bg-white"
                          draggable={false}
                        />

                        {/* Left-side user image overlay (always visible even if OG left half is white).
                            Starts fully FIT into the left half (no crop on paste), then you can zoom/drag to crop. */}
                        {leftSideImage && (
                          <div
                            className="pointer-events-none absolute inset-0"
                            style={{ clipPath: 'inset(0 50% 0 0)' }} // only left half
                          >
                            <img
                              src={leftSideImage}
                              alt="Left side"
                              className="absolute inset-0 h-full w-full object-contain"
                              style={{
                                transform: `translate(${cropPosition.x}px, ${cropPosition.y}px) scale(${cropPosition.scale})`,
                                transformOrigin: 'center center',
                              }}
                              draggable={false}
                            />
                          </div>
                        )}

                        {/* Resize handles (left half) */}
                        {leftSideImage && (
                          <div className="absolute inset-0 pointer-events-none" style={{ clipPath: 'inset(0 50% 0 0)' }}>
                            <div
                              className="pointer-events-auto absolute h-3 w-3 rounded-full border border-white bg-blue-500 shadow"
                              style={{ top: 6, left: 6, cursor: 'nwse-resize' }}
                              onMouseDown={handleResizeMouseDown('nw')}
                            />
                            <div
                              className="pointer-events-auto absolute h-3 w-3 rounded-full border border-white bg-blue-500 shadow"
                              style={{ top: 6, left: 'calc(50% - 12px)', cursor: 'nesw-resize' }}
                              onMouseDown={handleResizeMouseDown('ne')}
                            />
                            <div
                              className="pointer-events-auto absolute h-3 w-3 rounded-full border border-white bg-blue-500 shadow"
                              style={{ bottom: 6, left: 6, cursor: 'nesw-resize' }}
                              onMouseDown={handleResizeMouseDown('sw')}
                            />
                            <div
                              className="pointer-events-auto absolute h-3 w-3 rounded-full border border-white bg-blue-500 shadow"
                              style={{ bottom: 6, left: 'calc(50% - 12px)', cursor: 'nwse-resize' }}
                              onMouseDown={handleResizeMouseDown('se')}
                            />
                          </div>
                        )}

                        {/* No dimming mask: keep OG preview true-to-color. */}

                        {/* Center divider */}
                        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-[1px] bg-blue-500/60" />

                        {/* Empty-state hint (left half) */}
                        {!leftSideImage && (
                          <div className="absolute left-0 top-0 flex h-full w-1/2 items-center justify-center bg-gray-50/60">
                            <div className="text-center">
                              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                              </svg>
                              <p className="mt-2 text-sm text-gray-500">Drag & drop or paste image here</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) {
                            handleFileSelect(file)
                          }
                        }}
                      />
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {leftSideImage ? 'Replace Image' : 'Choose Image'}
                      </button>
                      {leftSideImage && (
                        <>
                          <button
                            onClick={() => setLeftSideImage(null)}
                            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                          >
                            Clear
                          </button>
                          <button
                            onClick={() => {
                              // Reset to "fit" (no initial crop) when we know OG pixel dimensions
                              if (!ogPixelSize) {
                                setCropPosition({ x: 0, y: 0, scale: 1 })
                                return
                              }
                              const leftHalfW = ogPixelSize.width / 2
                              const leftHalfH = ogPixelSize.height
                              // Best-effort: if we can't read the image size, fall back to scale=1
                              const img = new Image()
                              img.onload = () => {
                                const iw = img.naturalWidth || 0
                                const ih = img.naturalHeight || 0
                                let fitScale = 1
                                if (iw > 0 && ih > 0) {
                                  fitScale = Math.min(leftHalfW / iw, leftHalfH / ih)
                                }
                                setCropPosition({ x: 0, y: 0, scale: fitScale })
                              }
                              img.src = leftSideImage
                            }}
                            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                          >
                            Fit / Reset
                          </button>
                        </>
                      )}
                    </div>
                    <div className="mt-5 text-xs text-gray-500">
                      File: <span className="font-medium text-gray-900">{result.ogImage.fileName}</span>
                    </div>
                  </div>
                </div>
                </div>

                {/* Actions (right) */}
                <div className="lg:col-span-4">
                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="text-sm font-semibold text-gray-900">Actions</div>
                      <div className="text-xs text-gray-500">Export</div>
                    </div>

                    <div className="grid gap-3">
                      {leftSideImage ? (
                        <button
                          onClick={handleExportOGImage}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500"
                        >
                          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download Composite
                        </button>
                      ) : (
                        <>
                          <button
                            id="copy-og-btn"
                            onClick={handleCopyOGToClipboard}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900 shadow-sm transition-colors hover:bg-gray-50"
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                              />
                            </svg>
                            Copy OG Image
                          </button>

                          <button
                            onClick={() => {
                              if (!result.ogImage?.imageBase64 || !result.ogImage?.fileName) return
                              const link = document.createElement('a')
                              link.href = `data:${result.ogImage.imageMimeType || 'image/png'};base64,${result.ogImage.imageBase64}`
                              link.download = result.ogImage.fileName
                              document.body.appendChild(link)
                              link.click()
                              document.body.removeChild(link)
                            }}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500"
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Download OG Image
                          </button>
                        </>
                      )}
                    </div>

                    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
                      Add your own image to the left side for custom social sharing cards.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer note */}
        <div className="mt-10 text-center text-xs text-gray-500">
          This tool captures a screenshot preview of a Polymarket market page and formats it to a 7:8 or 1:1 image.
        </div>
      </div>
    </div>
  )
}
