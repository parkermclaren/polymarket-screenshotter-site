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
            // Use the same Polymarket icon mark as our other screenshot flows (e.g. template and square).
            'M136.267 152.495c0 7.265 0 10.897-2.376 12.697-2.375 1.801-5.872.82-12.867-1.143L8.632 132.51c-4.214-1.182-6.321-1.773-7.54-3.381-1.218-1.607-1.218-3.796-1.218-8.172V47.043c0-4.376 0-6.565 1.218-8.172 1.219-1.608 3.326-2.199 7.54-3.381L121.024 3.95c6.995-1.963 10.492-2.944 12.867-1.143s2.376 5.432 2.376 12.697zM27.904 122.228l93.062 26.117V96.113zm-12.73-12.117L108.217 84 15.174 57.889zm12.73-64.339 93.062 26.116V19.655z'
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
