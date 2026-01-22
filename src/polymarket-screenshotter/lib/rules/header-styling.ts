import { Page } from 'puppeteer'

/**
 * Styles the title, market icon, probability display, and Polymarket logo.
 */
export async function styleHeader(page: Page): Promise<void> {
  await page.evaluate(() => {
    // TITLE + HEADER CLUSTER SIZING/POSITIONING
    const title = document.querySelector('h1') as HTMLElement | null
    if (title) {
      title.style.setProperty('font-size', '30px', 'important')
      title.style.setProperty('line-height', '1.15', 'important')
      title.style.setProperty('margin-top', '0px', 'important')
      title.style.setProperty('margin-bottom', '10px', 'important')
      title.style.setProperty('padding-top', '0px', 'important')
    }

    // Remove the Middle East warning banner if present
    const middleEastBanner = document.querySelector('#middle-east-warning-banner') as HTMLElement | null
    if (middleEastBanner) {
      middleEastBanner.remove()
    }

    // Enlarge market icon (image to the left of the title)
    const marketIcon = document.querySelector('img[alt="Market icon"]') as HTMLImageElement | null
    if (marketIcon) {
      const targetSize = '80px'

      const iconBox =
        (marketIcon.closest('div.rounded-sm.overflow-hidden.relative') as HTMLElement | null) ||
        (marketIcon.closest('div.rounded-sm.overflow-hidden') as HTMLElement | null) ||
        (marketIcon.parentElement as HTMLElement | null)

      const boxes: HTMLElement[] = []
      if (iconBox) boxes.push(iconBox)
      if (iconBox?.parentElement) boxes.push(iconBox.parentElement as HTMLElement)
      if (iconBox?.parentElement?.parentElement) boxes.push(iconBox.parentElement.parentElement as HTMLElement)

      boxes.forEach(el => {
        el.style.setProperty('width', targetSize, 'important')
        el.style.setProperty('height', targetSize, 'important')
        el.style.setProperty('min-width', targetSize, 'important')
        el.style.setProperty('min-height', targetSize, 'important')
        if (getComputedStyle(el).position === 'static') {
          el.style.setProperty('position', 'relative', 'important')
        }
      })

      if (iconBox) {
        iconBox.style.setProperty('transform', 'none', 'important')
      }
    }

    // Enlarge the "X% chance" row below the title
    const chanceNumber = document.querySelector('number-flow-react') as HTMLElement | null
    if (chanceNumber) {
      chanceNumber.style.fontSize = '30px'
      chanceNumber.style.lineHeight = '1.1'

      // Enlarge the up/down triangle icon next to the % change
      const candidates: Array<HTMLElement | null | undefined> = [
        chanceNumber.parentElement as HTMLElement | null,
        (chanceNumber.closest('div')?.parentElement as HTMLElement | null) || null,
        (chanceNumber.closest('div')?.parentElement?.parentElement as HTMLElement | null) || null,
      ]

      for (const c of candidates) {
        if (!c) continue
        const svgs = Array.from(c.querySelectorAll('svg')) as SVGElement[]
        svgs.forEach(svg => {
          const vb = svg.getAttribute('viewBox') || ''
          const wAttr = svg.getAttribute('width') || ''
          const hAttr = svg.getAttribute('height') || ''
          const looksLikeDeltaArrow = vb === '0 0 12 12' || wAttr === '12' || hAttr === '12'
          if (!looksLikeDeltaArrow) return

          const el = svg as unknown as HTMLElement
          el.style.setProperty('width', '16px', 'important')
          el.style.setProperty('height', '16px', 'important')
        })

        // Scale the delta number container
        const deltaContainer = c.querySelector('div.flex.items-center.w-auto') as HTMLElement | null
        if (deltaContainer) {
          const overflowWrapper = deltaContainer.closest('div.overflow-hidden') as HTMLElement | null
          if (overflowWrapper) {
            overflowWrapper.style.setProperty('transform', 'scale(1.35)', 'important')
            overflowWrapper.style.setProperty('transform-origin', 'left center', 'important')
            overflowWrapper.style.setProperty('overflow', 'hidden', 'important')
          } else {
            deltaContainer.style.setProperty('transform', 'scale(1.35)', 'important')
            deltaContainer.style.setProperty('transform-origin', 'left center', 'important')
          }
        }
      }
    }

    // Enlarge the Polymarket logo on the right
    const polymarketLogos = Array.from(
      document.querySelectorAll('svg[viewBox="0 0 911 168"]')
    ) as HTMLElement[]
    polymarketLogos.forEach(logo => {
      logo.style.setProperty('height', '32px', 'important')
      logo.style.setProperty('width', 'auto', 'important')
    })

    // Enlarge the Share and Add to favorites buttons
    const shareButton = document.querySelector('button[aria-label="Share"]') as HTMLElement | null
    if (shareButton) {
      shareButton.style.setProperty('width', '24px', 'important')
      shareButton.style.setProperty('height', '24px', 'important')
      shareButton.style.setProperty('padding', '2px', 'important')
      const shareSvg = shareButton.querySelector('svg') as HTMLElement | null
      if (shareSvg) {
        shareSvg.style.setProperty('width', '22px', 'important')
        shareSvg.style.setProperty('height', '22px', 'important')
      }
    }

    const favoritesButton = document.querySelector('button[aria-label="Add to favorites"]') as HTMLElement | null
    if (favoritesButton) {
      favoritesButton.style.setProperty('width', '24px', 'important')
      favoritesButton.style.setProperty('height', '24px', 'important')
      favoritesButton.style.setProperty('padding', '2px', 'important')
      const bookmarkIcon = favoritesButton.querySelector('.bookmarkButton') as HTMLElement | null
      if (bookmarkIcon) {
        bookmarkIcon.style.setProperty('width', '22px', 'important')
        bookmarkIcon.style.setProperty('height', '22px', 'important')
        const bookmarkSvg = bookmarkIcon.querySelector('svg') as HTMLElement | null
        if (bookmarkSvg) {
          bookmarkSvg.style.setProperty('width', '22px', 'important')
          bookmarkSvg.style.setProperty('height', '22px', 'important')
        }
      }
    }
  })
}
