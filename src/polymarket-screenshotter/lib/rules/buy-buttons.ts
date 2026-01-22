import { Page } from 'puppeteer'

/**
 * Styles buy buttons, ensures correct pricing sum, and makes container visible.
 */
export async function styleBuyButtons(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Make Buy buttons taller/thicker to fill more of their section
    document.querySelectorAll('.trading-button').forEach(btn => {
      const button = btn as HTMLElement
      button.style.setProperty('height', '72px', 'important')
      button.style.setProperty('min-height', '72px', 'important')
      button.style.setProperty('padding-top', '20px', 'important')
      button.style.setProperty('padding-bottom', '20px', 'important')
    })

    // Also increase the span wrapper height
    document.querySelectorAll('.trading-button').forEach(btn => {
      const parent = btn.parentElement as HTMLElement | null
      if (parent && parent.tagName === 'SPAN') {
        parent.style.setProperty('height', '72px', 'important')
      }
    })

    // Style the button text to be slightly larger
    document.querySelectorAll('.trading-button-text').forEach(text => {
      const el = text as HTMLElement
      el.style.setProperty('font-size', '18px', 'important')
      el.style.setProperty('font-weight', '600', 'important')
    })

    // Ensure Buy Yes / Buy No cents sum to 100.0 by adjusting Buy No rounding
    const yesTextEl = Array.from(document.querySelectorAll('.trading-button-text')).find(el =>
      (el as HTMLElement).textContent?.trim().toLowerCase().startsWith('buy yes')
    ) as HTMLElement | undefined
    const noTextEl = Array.from(document.querySelectorAll('.trading-button-text')).find(el =>
      (el as HTMLElement).textContent?.trim().toLowerCase().startsWith('buy no')
    ) as HTMLElement | undefined

    const parseCents = (text: string): number | null => {
      const match = text.match(/([0-9]+(?:\.[0-9]+)?)¢/)
      if (!match) return null
      const value = Number(match[1])
      return Number.isNaN(value) ? null : value
    }

    const formatCents = (value: number): string => value.toFixed(1)

    if (yesTextEl && noTextEl) {
      const yesText = yesTextEl.textContent || ''
      const noText = noTextEl.textContent || ''
      const yesValue = parseCents(yesText)
      const noValue = parseCents(noText)

      if (yesValue !== null && noValue !== null) {
        const adjustedNo = Math.max(0, 100 - yesValue)
        const updatedNoText = noText.replace(/([0-9]+(?:\.[0-9]+)?)¢/, `${formatCents(adjustedNo)}¢`)
        noTextEl.textContent = updatedNoText
      }
    }

    // Add padding below the buttons container
    const tradingButton = document.querySelector('.trading-button')
    if (tradingButton) {
      let container: HTMLElement | null = tradingButton as HTMLElement
      for (let i = 0; i < 10 && container; i++) {
        container = container.parentElement as HTMLElement | null
        if (!container) break
        const classes = container.className || ''
        if (classes.includes('h-20') || classes.includes('bg-background')) {
          container.style.setProperty('padding-top', '20px', 'important')
          container.style.setProperty('padding-bottom', '16px', 'important')
          container.style.setProperty('height', 'auto', 'important')
          container.style.setProperty('min-height', '100px', 'important')
          break
        }
      }
    }

    // PRODUCTION SAFETY: Ensure the Buy buttons container is visible and fixed at the bottom
    const btn = document.querySelector('.trading-button') as HTMLElement | null
    if (btn) {
      const fixedAncestor = (() => {
        let el: HTMLElement | null = btn
        for (let i = 0; i < 12 && el; i++) {
          const style = window.getComputedStyle(el)
          if (style.position === 'fixed') return el
          el = el.parentElement as HTMLElement | null
        }
        return null
      })()

      const container = fixedAncestor || (btn.closest('nav') as HTMLElement | null)
      if (container) {
        container.style.setProperty('display', 'flex', 'important')
        container.style.setProperty('visibility', 'visible', 'important')
        container.style.setProperty('opacity', '1', 'important')
        container.style.setProperty('position', 'fixed', 'important')
        container.style.setProperty('left', '0', 'important')
        container.style.setProperty('right', '0', 'important')
        container.style.setProperty('bottom', '0', 'important')
        container.style.setProperty('z-index', '99999', 'important')
      }
    }
  })
}
