import { Page } from 'puppeteer'

/**
 * Makes chart axis labels visible and properly sized.
 * Handles x-axis timestamps and y-axis percentages.
 */
export async function styleAxisLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Set the CSS variable to original Polymarket light gray
    document.documentElement.style.setProperty('--neutral-200', '#9ca3af', 'important')

    // Force all axis ticks to be visible
    document.querySelectorAll('.visx-axis-tick').forEach(tick => {
      const el = tick as SVGGElement
      el.setAttribute('opacity', '1')
      el.style.opacity = '1'
      el.style.display = 'block'
    })

    // Target all text elements - keep original fill but ensure visibility and larger size
    document.querySelectorAll('.visx-axis-tick text, .visx-axis-bottom text').forEach(text => {
      const el = text as SVGTextElement
      el.setAttribute('opacity', '1')
      el.setAttribute('font-size', '13')
      el.setAttribute('font-weight', '500')
      el.style.opacity = '1'
      el.style.display = 'block'
      el.style.visibility = 'visible'
      el.style.fontSize = '13px'
      el.style.fontWeight = '500'
    })

    // Make Y-axis percentage labels larger
    document.querySelectorAll('.visx-axis-right text').forEach(text => {
      const el = text as SVGTextElement
      el.setAttribute('font-size', '14')
      el.setAttribute('font-weight', '500')
      el.style.fontSize = '14px'
      el.style.fontWeight = '500'
    })

    // Ensure the left-most x-axis time label doesn't get clipped
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

    // Ensure chart SVG allows overflow
    const chartSvg = document.querySelector('#group-chart-container svg') as SVGElement | null
    if (chartSvg) {
      chartSvg.style.overflow = 'visible'
      chartSvg.setAttribute('overflow', 'visible')
    }
  })
}
