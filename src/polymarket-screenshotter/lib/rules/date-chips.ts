import { Page } from 'puppeteer'

interface DateChipsOptions {
  baseChartHeight?: number
  minChartHeight?: number
  minReduce?: number
  maxReduce?: number
}

/**
 * Detects the presence of a "Past" or date chips row (e.g. "Mar 31", "Dec 31")
 * and adjusts the chart height to prevent layout overlap.
 */
export async function adjustHeightForDateChips(page: Page, options: DateChipsOptions = {}): Promise<void> {
  const {
    baseChartHeight = 400,
    minChartHeight = 300,
    minReduce = 28,
    maxReduce = 90,
  } = options

  await page.evaluate(
    ({ baseChartHeight, minChartHeight, minReduce, maxReduce }) => {
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

      // Ensure chips look like actual date chips (height around 28-40px)
      const chipRects = uniqueChips
        .map(chip => chip.getBoundingClientRect())
        .filter(rect => rect.height >= 24 && rect.height <= 44)
      if (chipRects.length < 2) return null

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

      return null
    }

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
    if (!chartContainer) return

    let reduceBy = 0
    const chipsRow = getChipsRow()
    if (chipsRow) {
      const chartRect = chartContainer.getBoundingClientRect()
      const chipsRect = chipsRow.getBoundingClientRect()

      // Guardrails: ensure chips row is above the chart and close enough to be relevant
      if (chipsRect.bottom >= chartRect.top - 4) return
      if (chartRect.top - chipsRect.bottom > 120) return

      // Require at least two visible chips inside the detected row
      const chipTexts = Array.from(chipsRow.querySelectorAll('.rounded-full'))
        .map(el => (el as HTMLElement).textContent?.trim() || '')
        .filter(text => text === 'Past' || monthRe.test(text))
      if (chipTexts.length < 2) return

      if (chipsRect.height < 36) return

      const chipsHeight = Math.round(chipsRect.height)
      reduceBy = Math.min(maxReduce, Math.max(minReduce, chipsHeight))
    }

    const newChartHeight = `${Math.max(minChartHeight, baseChartHeight - reduceBy)}px`

    chartContainer.style.setProperty('--chart-height', newChartHeight, 'important')
    chartContainer.style.setProperty('height', newChartHeight, 'important')
    chartContainer.style.setProperty('min-height', newChartHeight, 'important')

    const chartSvg = chartContainer.querySelector('svg') as SVGElement | null
    if (chartSvg) {
      chartSvg.setAttribute('height', newChartHeight.replace('px', ''))
      chartSvg.style.setProperty('height', newChartHeight, 'important')
    }
  },
  { baseChartHeight, minChartHeight, minReduce, maxReduce }
  )
}
