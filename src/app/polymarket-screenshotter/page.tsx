'use client'

import { useState, useCallback } from 'react'

interface ScreenshotResult {
  success: boolean
  fileName?: string
  marketTitle?: string
  url?: string
  imageBase64?: string
  imageMimeType?: string
  error?: string
}

export default function PolymarketScreenshotterPage() {
  const [url, setUrl] = useState('')
  const [timeRange, setTimeRange] = useState<'1h' | '6h' | '1d' | '1w' | '1m' | 'max'>('1d')
  const [chartWatermark, setChartWatermark] = useState<'none' | 'wordmark' | 'icon'>('none')
  const [mode, setMode] = useState<'dom' | 'template'>('dom')
  const [aspect, setAspect] = useState<'twitter' | 'square'>('twitter')
  const [debugLayout, setDebugLayout] = useState(false)
  const [showPotentialPayout, setShowPotentialPayout] = useState(false)
  const [payoutInvestment, setPayoutInvestment] = useState(150)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScreenshotResult | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      const params = new URLSearchParams({
        url,
        timeRange,
        return: 'json',
        mode,
        ...(chartWatermark !== 'none' && { chartWatermark }),
        ...(debugLayout && { debugLayout: '1' }),
        ...(aspect === 'square' && { aspect: 'square' }),
        ...(showPotentialPayout && { showPotentialPayout: '1' }),
        ...(showPotentialPayout && payoutInvestment && { payoutInvestment: payoutInvestment.toString() })
      })
      const response = await fetch(`/api/polymarket-screenshot?${params.toString()}`)
      const data = await response.json()

      if (!data.success) {
        setError(data.error || 'Screenshot capture failed')
        return
      }

      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [url, timeRange, chartWatermark, mode, debugLayout, aspect, showPotentialPayout, payoutInvestment])

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleCapture()
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

          <div className="hidden items-center gap-6 text-sm text-gray-600 md:flex">
            <span className="font-medium text-gray-900">Trending</span>
            <span>Breaking</span>
            <span>Politics</span>
            <span>Crypto</span>
            <span>Tech</span>
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

          {/* Options Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Time Range */}
            <div>
              <label htmlFor="time-range" className="block text-sm font-medium text-gray-900 mb-2">
                Time Range
              </label>
              <select
                id="time-range"
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
                disabled={loading}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
              >
                <option value="1h">1H</option>
                <option value="6h">6H</option>
                <option value="1d">1D</option>
                <option value="1w">1W</option>
                <option value="1m">1M</option>
                <option value="max">MAX</option>
              </select>
            </div>

            {/* Aspect Ratio */}
            <div>
              <label htmlFor="aspect" className="block text-sm font-medium text-gray-900 mb-2">
                Aspect Ratio
              </label>
              <select
                id="aspect"
                value={aspect}
                onChange={(e) => setAspect(e.target.value as typeof aspect)}
                disabled={loading}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
              >
                <option value="twitter">7:8 (Twitter)</option>
                <option value="square">1:1 (Square)</option>
              </select>
            </div>

            {/* Chart Watermark */}
            <div>
              <label htmlFor="chart-watermark" className="block text-sm font-medium text-gray-900 mb-2">
                Chart Watermark
              </label>
              <select
                id="chart-watermark"
                value={chartWatermark}
                onChange={(e) => setChartWatermark(e.target.value as typeof chartWatermark)}
                disabled={loading || mode === 'template'}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
              >
                <option value="none">None</option>
                <option value="wordmark">Wordmark</option>
                <option value="icon">Icon</option>
              </select>
            </div>

            {/* Render Mode */}
            <div>
              <label htmlFor="mode" className="block text-sm font-medium text-gray-900 mb-2">
                Render Mode
              </label>
              <select
                id="mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                disabled={loading}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:bg-gray-50"
              >
                <option value="dom">DOM</option>
                <option value="template">Template (beta)</option>
              </select>
            </div>
          </div>

          {/* Secondary Options Row */}
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

            {/* Debug Layout */}
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

          <p className="mt-4 text-xs text-gray-500">Tip: hit <span className="font-medium text-gray-900">Enter</span> to capture.</p>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Result */}
        {result && result.imageBase64 && (
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Preview (left) */}
            <div className="lg:col-span-8">
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold text-gray-900">{result.marketTitle}</h2>
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

        {/* Footer note */}
        <div className="mt-10 text-center text-xs text-gray-500">
          This tool captures a screenshot preview of a Polymarket market page and formats it to a 7:8 or 1:1 image.
        </div>
      </div>
    </div>
  )
}
