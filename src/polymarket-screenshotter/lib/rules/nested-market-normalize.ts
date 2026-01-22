import { Page } from 'puppeteer'

/**
 * Normalizes nested market overlays (event -> market drawer) to match regular markets.
 * Only use this for nested market URLs; regular markets should be unchanged.
 */
export async function normalizeNestedMarketLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    // 1) Remove the nested back header (back arrow + top action icons)
    const backButtons = Array.from(document.querySelectorAll('button'))
    backButtons.forEach(btn => {
      const svg = btn.querySelector('svg')
      const isBack = !!svg && svg.classList.contains('rotate-90')
      if (!isBack) return

      // Remove the closest header container (typically flex + justify-between + items-center)
      let header: HTMLElement | null = btn
      for (let i = 0; i < 8 && header; i++) {
        header = header.parentElement as HTMLElement | null
        if (!header) break
        const classes = header.className || ''
        if (classes.includes('justify-between') && classes.includes('items-center')) {
          header.remove()
          break
        }
      }
    })

    // 2) Remove the code icon button (< />) used in nested markets
    const codeButtons = Array.from(document.querySelectorAll('button'))
    codeButtons.forEach(btn => {
      const hasLucideCode = !!btn.querySelector('svg.lucide-code')
      const looksLikeCodeIcon = btn.innerHTML.includes('polyline points="16 18 22 12 16 6"')
      if (hasLucideCode || looksLikeCodeIcon) {
        btn.remove()
      }
    })

    // 3) Remove the top volume header row (e.g. "$5,203,519 Vol.")
    const possibleVolume = Array.from(document.querySelectorAll('p, span, div'))
    possibleVolume.forEach(el => {
      const text = (el as HTMLElement).textContent?.trim() || ''
      if (!/^\$[\d,]+\s+Vol\.?$/i.test(text)) return

      const rect = (el as HTMLElement).getBoundingClientRect()
      // Only remove if it's near the very top (header row), not the volume row above tabs
      if (rect.top > 200) return

      let container: HTMLElement | null = el as HTMLElement
      for (let i = 0; i < 6 && container; i++) {
        container = container.parentElement as HTMLElement | null
        if (!container) break
        const classes = container.className || ''
        if (classes.includes('flex') && classes.includes('items-center')) {
          container.remove()
          break
        }
      }
    })

    // 4) Normalize main spacing to match regular markets
    const main = document.querySelector('main') as HTMLElement | null
    if (main) {
      main.style.setProperty('margin-top', '0', 'important')
      main.style.setProperty('padding-top', '8px', 'important')
    }
    document.body.style.setProperty('padding-top', '0', 'important')
    document.body.style.setProperty('margin-top', '0', 'important')
  })
}
