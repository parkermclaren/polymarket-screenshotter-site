import { Page } from 'puppeteer'

export type ChartWatermarkMode = 'none' | 'wordmark' | 'icon'

/**
 * Applies watermark and ensures chart container is positioned correctly.
 */
export async function applyChartWatermark(page: Page, watermarkMode: ChartWatermarkMode): Promise<void> {
  await page.evaluate((mode: ChartWatermarkMode) => {
    const enableWatermark = mode !== 'none'
    
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
    if (chartContainer) {
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
            'M68.5 0L0 34.5V103.5L68.5 138L137 103.5V34.5L68.5 0ZM68.5 12.5L124.5 40.5L68.5 68.5L12.5 40.5L68.5 12.5ZM12.5 109.5V53.5L62.5 78.5V124.5L12.5 99.5V109.5ZM74.5 124.5V78.5L124.5 53.5V109.5L74.5 124.5Z'
          )
          path.setAttribute('fill', 'currentColor')
          svg.appendChild(path)
          return svg
        }

        const node: Node = mode === 'icon' ? buildIcon() : buildWordmark()
        overlay.appendChild(node)
        chartContainer.appendChild(overlay)
      }
    }
  }, watermarkMode)
}
