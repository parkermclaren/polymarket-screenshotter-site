import { Page } from 'puppeteer'

/**
 * Styles the volume row, tabs, and related elements.
 * Also handles "Related" section removal.
 */
export async function styleVolumeRow(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Hide "Related" heading - we want Vol row to be right above Buy buttons
    document.querySelectorAll('h3').forEach(h3 => {
      const text = (h3 as HTMLElement).textContent?.trim() || ''
      if (text === 'Related') {
        const parent = h3.parentElement
        if (parent) {
          parent.remove()
        } else {
          (h3 as HTMLElement).remove()
        }
      }
    })

    // Make Vol row text and buttons larger
    document.querySelectorAll('p').forEach(p => {
      const text = (p as HTMLElement).textContent || ''
      if (text.includes('Vol.')) {
        // Hide volume line entirely if under $50,000
        const raw = text.replace(/[^0-9.,]/g, '')
        const numeric = Number(raw.replace(/,/g, ''))
        const volContainer = p.closest('div.flex.items-center.gap-2\\.5') as HTMLElement | null
        if (!Number.isNaN(numeric) && numeric < 50000 && volContainer) {
          volContainer.style.setProperty('display', 'none', 'important')
          return
        }

        ;(p as HTMLElement).style.setProperty('font-size', '18px', 'important')
        ;(p as HTMLElement).style.setProperty('font-weight', '600', 'important')
        
        // Move the row down (closer to Buy buttons) by adding top margin
        // and reducing the bottom margin.
        const rowContainer =
          (p.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null) ||
          (p.closest('div.flex.w-full') as HTMLElement | null)
        if (rowContainer) {
          rowContainer.style.setProperty('margin-top', '16px', 'important')
          rowContainer.style.setProperty('margin-bottom', '6px', 'important')
        }
      }
    })

    // Make the time period tabs larger (1H, 6H, 1D, MAX)
    document.querySelectorAll('button[role="tab"]').forEach(btn => {
      const button = btn as HTMLElement
      button.style.setProperty('font-size', '17px', 'important')
      button.style.setProperty('padding', '6px 8px', 'important')
      button.style.setProperty('font-weight', '500', 'important')
    })

    // Make the settings icon larger
    document.querySelectorAll('svg[viewBox="0 0 18 18"]').forEach(svg => {
      const el = svg as HTMLElement
      el.style.setProperty('width', '24px', 'important')
      el.style.setProperty('height', '24px', 'important')
    })
  })
}
