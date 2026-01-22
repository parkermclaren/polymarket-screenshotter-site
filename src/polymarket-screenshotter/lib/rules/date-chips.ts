import { Page } from 'puppeteer'

/**
 * Detects the presence of a "Past" or date chips row (e.g. "Mar 31", "Dec 31")
 * and adjusts the chart height to prevent layout overlap.
 */
export async function adjustHeightForDateChips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const monthRe = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$/i
    
    const getChipsRow = (): HTMLElement | null => {
      const chipCandidates = Array.from(document.querySelectorAll('button, a, div'))
        .map(el => (el as HTMLElement))
        .map(el => el.classList.contains('rounded-full') ? el : (el.closest('.rounded-full') as HTMLElement | null))
        .filter((el): el is HTMLElement => !!el)
        .filter(el => {
          const text = (el.textContent || '').trim()
          return text === 'Past' || monthRe.test(text)
        })

      const uniqueChips = Array.from(new Set(chipCandidates))
      if (uniqueChips.length < 2) return null

      let el: HTMLElement | null = uniqueChips[0]
      for (let i = 0; i < 8 && el; i++) {
        const current = el
        const count = uniqueChips.filter(c => current.contains(c)).length
        if (count >= 2) {
          const className = current.className || ''
          const style = window.getComputedStyle(current)
          if (
            style.display.includes('flex') ||
            className.includes('overflow-x-auto') ||
            className.includes('snap-x')
          ) {
            const pyRow =
              (current.closest('div.py-4') as HTMLElement | null) ||
              (current.closest('div[class*="py-"]') as HTMLElement | null)
            return pyRow || current
          }
        }
        el = current.parentElement as HTMLElement | null
      }
      
      const fallback =
        (uniqueChips[0].closest('div.py-4') as HTMLElement | null) ||
        (uniqueChips[0].closest('div[class*="py-"]') as HTMLElement | null) ||
        (uniqueChips[0].parentElement as HTMLElement | null)
      return fallback
    }

    const chipsRow = getChipsRow()
    if (chipsRow) {
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
        const baseChartHeight = 400
        const chipsHeight = Math.round(chipsRow.getBoundingClientRect().height)
        const reduceBy = Math.min(90, Math.max(28, chipsHeight))
        const newChartHeight = `${Math.max(300, baseChartHeight - reduceBy)}px`
        
        chartContainer.style.setProperty('--chart-height', newChartHeight, 'important')
        chartContainer.style.setProperty('height', newChartHeight, 'important')
        chartContainer.style.setProperty('min-height', newChartHeight, 'important')
        
        const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
        if (chartSvg) {
          chartSvg.setAttribute('height', newChartHeight.replace('px', ''))
          chartSvg.style.setProperty('height', newChartHeight, 'important')
        }
      }
    }
  })
}
