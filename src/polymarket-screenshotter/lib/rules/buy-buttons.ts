import { Page } from 'puppeteer'

export interface BuyButtonOptions {
  showPotentialPayout?: boolean
  payoutInvestment?: number // The investment amount to show (e.g., 150 for "$150 → $197")
}

/**
 * Styles buy buttons, ensures correct pricing sum, and makes container visible.
 * Optionally adds potential payout text below the buttons.
 */
export async function styleBuyButtons(page: Page, options: BuyButtonOptions = {}): Promise<void> {
  const { showPotentialPayout = false, payoutInvestment = 150 } = options
  await page.evaluate((showPayout: boolean, investment: number) => {
    // Button heights - smaller when showing payout to make room for text
    const buttonHeight = showPayout ? '56px' : '72px'
    const buttonPadding = showPayout ? '14px' : '20px'

    // Make Buy buttons taller/thicker to fill more of their section
    document.querySelectorAll('.trading-button').forEach(btn => {
      const button = btn as HTMLElement
      button.style.setProperty('height', buttonHeight, 'important')
      button.style.setProperty('min-height', buttonHeight, 'important')
      button.style.setProperty('padding-top', buttonPadding, 'important')
      button.style.setProperty('padding-bottom', buttonPadding, 'important')
    })

    // Also increase the span wrapper height
    document.querySelectorAll('.trading-button').forEach(btn => {
      const parent = btn.parentElement as HTMLElement | null
      if (parent && parent.tagName === 'SPAN') {
        parent.style.setProperty('height', buttonHeight, 'important')
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

        // Add payout text if enabled
        if (showPayout && investment > 0) {
          const calculatePayout = (priceInCents: number): number => {
            // Payout = investment / (price in dollars)
            // e.g., $150 at 76¢ = $150 / $0.76 = ~$197
            const priceInDollars = priceInCents / 100
            return Math.round(investment / priceInDollars)
          }

          const yesPayout = calculatePayout(yesValue)
          const noPayout = calculatePayout(adjustedNo)

          // Find the button containers to add payout text below them
          const yesButton = yesTextEl.closest('button') as HTMLElement | null
          const noButton = noTextEl.closest('button') as HTMLElement | null

          const formatMoney = (value: number): string => {
            return new Intl.NumberFormat('en-US').format(value)
          }

          const createPayoutElement = (payout: number, isYes: boolean): HTMLElement => {
            const payoutDiv = document.createElement('div')
            payoutDiv.className = 'payout-text'
            payoutDiv.style.cssText = `
              text-align: center;
              font-size: 19px;
              font-weight: 500;
              margin-top: 10px;
              color: #374151;
              font-family: inherit;
              line-height: 1.4;
            `
            // Format: $150 → $197
            const investmentStr = `$${formatMoney(investment)}`
            const payoutStr = `$${formatMoney(payout)}`

            payoutDiv.innerHTML = `
              <span style="color: #4B5563; font-weight: 500;">${investmentStr}</span>
              <span style="
                color: #6B7280;
                margin: 0 8px;
                font-weight: 800;
                font-size: 24px;
                line-height: 1;
                display: inline-block;
                transform: translateY(1px);
              ">→</span>
              <span style="color: ${isYes ? '#16a34a' : '#dc2626'}; font-weight: 700; font-size: 20px;">${payoutStr}</span>
            `
            return payoutDiv
          }

          // Wrap each button's span parent in a flex container and add payout text
          const wrapButtonWithPayout = (button: HTMLElement | null, payout: number, isYes: boolean) => {
            if (!button) return

            // Find the span wrapper (parent of button)
            const spanWrapper = button.parentElement
            if (!spanWrapper || spanWrapper.tagName !== 'SPAN') return

            // Check if already wrapped
            if (spanWrapper.parentElement?.classList.contains('payout-wrapper')) return

            // Create wrapper div
            const wrapper = document.createElement('div')
            wrapper.className = 'payout-wrapper'
            wrapper.style.cssText = `
              display: flex;
              flex-direction: column;
              align-items: center;
              flex: 1;
            `

            // Insert wrapper where span was
            spanWrapper.parentElement?.insertBefore(wrapper, spanWrapper)
            wrapper.appendChild(spanWrapper)

            // Add payout text
            const payoutEl = createPayoutElement(payout, isYes)
            wrapper.appendChild(payoutEl)
          }

          wrapButtonWithPayout(yesButton, yesPayout, true)
          wrapButtonWithPayout(noButton, noPayout, false)
        }
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
          container.style.setProperty('padding-top', showPayout ? '8px' : '20px', 'important')
          container.style.setProperty('padding-bottom', showPayout ? '10px' : '16px', 'important')
          container.style.setProperty('height', 'auto', 'important')
          // Increase min-height when showing payout to accommodate larger text
          container.style.setProperty('min-height', showPayout ? '132px' : '100px', 'important')
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
        container.style.setProperty('flex-direction', 'row', 'important')
        container.style.setProperty('align-items', showPayout ? 'flex-start' : 'center', 'important')
        container.style.setProperty('visibility', 'visible', 'important')
        container.style.setProperty('opacity', '1', 'important')
        container.style.setProperty('position', 'fixed', 'important')
        container.style.setProperty('left', '0', 'important')
        container.style.setProperty('right', '0', 'important')
        container.style.setProperty('bottom', '0', 'important')
        container.style.setProperty('z-index', '99999', 'important')
      }
    }
  }, showPotentialPayout, payoutInvestment)
}
