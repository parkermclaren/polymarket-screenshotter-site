import { Page } from 'puppeteer'

/**
 * Adds colored debug overlays and metrics logging to visualize layout regions.
 */
export async function applyDebugOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const outlines: Array<{ el: HTMLElement; label: string; color: string }> = []
    const label = (text: string, color: string, top: number, left: number) => {
      const badge = document.createElement('div')
      badge.textContent = text
      badge.style.setProperty('position', 'fixed', 'important')
      badge.style.setProperty('top', `${top}px`, 'important')
      badge.style.setProperty('left', `${left}px`, 'important')
      badge.style.setProperty('background', color, 'important')
      badge.style.setProperty('color', '#fff', 'important')
      badge.style.setProperty('font-size', '12px', 'important')
      badge.style.setProperty('font-weight', '600', 'important')
      badge.style.setProperty('padding', '2px 6px', 'important')
      badge.style.setProperty('border-radius', '4px', 'important')
      badge.style.setProperty('z-index', '999999', 'important')
      badge.style.setProperty('opacity', '0.9', 'important')
      document.body.appendChild(badge)
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

    const chartContainer = findChartContainer()
    const chipsRow = getChipsRow()
    if (chipsRow && chartContainer) {
      const chartRect = chartContainer.getBoundingClientRect()
      const chipsRect = chipsRow.getBoundingClientRect()
      if (chipsRect.bottom >= chartRect.top - 4) {
        // Ignore false positives below/overlapping the chart
        return
      }
      if (chartRect.top - chipsRect.bottom > 120) {
        return
      }
      const chipTexts = Array.from(chipsRow.querySelectorAll('.rounded-full'))
        .map(el => (el as HTMLElement).textContent?.trim() || '')
        .filter(text => text === 'Past' || monthRe.test(text))
      if (chipTexts.length < 2 || chipsRect.height < 36) {
        return
      }
    }
    const volText = Array.from(document.querySelectorAll('p')).find(p =>
      ((p as HTMLElement).textContent || '').includes('Vol.')
    ) as HTMLElement | undefined
    const volRow =
      (volText?.closest('div.flex.w-full') as HTMLElement | null) ||
      (volText?.closest('div') as HTMLElement | null)

    const tradingButton = document.querySelector('.trading-button') as HTMLElement | null
    const buyContainer = tradingButton?.closest('div') as HTMLElement | null

    if (chipsRow) outlines.push({ el: chipsRow, label: 'chips-row', color: '#b45309' })
    if (chartContainer) outlines.push({ el: chartContainer, label: 'chart', color: '#2563eb' })
    if (volRow) outlines.push({ el: volRow, label: 'vol-row', color: '#16a34a' })
    if (buyContainer) outlines.push({ el: buyContainer, label: 'buy-container', color: '#dc2626' })

    outlines.forEach(({ el, label: name, color }) => {
      el.style.setProperty('outline', `2px solid ${color}`, 'important')
      const rect = el.getBoundingClientRect()
      label(`${name} ${Math.round(rect.height)}px`, color, Math.max(8, rect.top + 4), Math.max(8, rect.left + 4))
    })

    const summary = {
      chipsRowHeight: chipsRow ? Math.round(chipsRow.getBoundingClientRect().height) : null,
      chartHeight: chartContainer ? Math.round(chartContainer.getBoundingClientRect().height) : null,
      volRowTop: volRow ? Math.round(volRow.getBoundingClientRect().top) : null,
      buyContainerTop: buyContainer ? Math.round(buyContainer.getBoundingClientRect().top) : null,
    }
    console.log('[DEBUG_LAYOUT]', JSON.stringify(summary))
  })
}
