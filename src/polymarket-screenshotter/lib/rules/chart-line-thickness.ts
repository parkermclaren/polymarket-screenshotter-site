import { Page } from 'puppeteer'

export type ChartLineThickness = 'normal' | 'thick'

/**
 * Increase the chart line stroke width for readability.
 *
 * Polymarket charts are typically SVG (visx). We try to target only the
 * "data series" paths and avoid axes/grid where possible.
 */
export async function setChartLineThickness(page: Page, thickness: ChartLineThickness): Promise<void> {
  if (thickness === 'normal') return

  await page.evaluate(() => {
    const svg =
      (document.querySelector('#group-chart-container svg') as SVGElement | null) ||
      (document.querySelector('svg[class*="visx"]') as SVGElement | null) ||
      (document.querySelector('svg[class*="recharts"]') as SVGElement | null) ||
      null

    if (!svg) return

    const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[]

    const isTransparent = (val: string) =>
      val === 'none' || val === 'transparent' || val === 'rgba(0, 0, 0, 0)' || val === 'rgb(0 0 0 / 0)'

    const candidates = paths.filter(p => {
      // Exclude axes/ticks/labels regions
      if (p.closest('.visx-axis') || p.closest('[class*="visx-axis"]')) return false

      const d = p.getAttribute('d') || ''
      // Data paths are usually long; skip tiny icon/marker paths
      if (d.length < 60) return false

      const style = window.getComputedStyle(p)
      const stroke = (p.getAttribute('stroke') || style.stroke || '').trim()
      if (!stroke || isTransparent(stroke)) return false

      const fill = (p.getAttribute('fill') || style.fill || '').trim()
      // We want line/area outline paths; most series lines have fill="none"
      if (fill && !isTransparent(fill) && fill !== 'none') return false

      return true
    })

    // If our filter is too strict (e.g. series paths have fill set), fall back
    // to any stroked path not in axes.
    const finalPaths =
      candidates.length > 0
        ? candidates
        : paths.filter(p => {
            if (p.closest('.visx-axis') || p.closest('[class*="visx-axis"]')) return false
            const d = p.getAttribute('d') || ''
            if (d.length < 60) return false
            const style = window.getComputedStyle(p)
            const stroke = (p.getAttribute('stroke') || style.stroke || '').trim()
            return !!stroke && !isTransparent(stroke)
          })

    for (const p of finalPaths) {
      p.style.setProperty('stroke-width', '4', 'important')
      p.style.setProperty('stroke-linecap', 'round', 'important')
      p.style.setProperty('stroke-linejoin', 'round', 'important')
    }
  })
}

