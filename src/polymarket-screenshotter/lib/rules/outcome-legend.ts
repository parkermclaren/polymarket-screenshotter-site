import { Page } from 'puppeteer'

/**
 * Styles the outcome legend (the colored chips showing outcomes like "8-10 37%")
 * to be larger and more readable in screenshots.
 */
export async function styleOutcomeLegend(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Find the legend container - it's a flex container with outcome items
    // Each outcome has: color dot + text with outcome name and percentage
    
    // Style the color dots to be larger
    document.querySelectorAll('.size-2.rounded-full').forEach(dot => {
      const el = dot as HTMLElement
      // Check if it's inside a legend item (has a sibling p element with percentage)
      const parent = el.parentElement
      if (parent?.querySelector('p')) {
        el.style.setProperty('width', '12px', 'important')
        el.style.setProperty('height', '12px', 'important')
        el.style.setProperty('min-width', '12px', 'important')
        el.style.setProperty('min-height', '12px', 'important')
      }
    })

    // Style the legend text to be larger
    // Target paragraphs with text-[13px] class that contain percentage spans
    document.querySelectorAll('p.text-\\[13px\\]').forEach(p => {
      const el = p as HTMLElement
      // Check if this contains a percentage (has a span with font-medium)
      if (el.querySelector('span.font-medium')) {
        el.style.setProperty('font-size', '17px', 'important')
        el.style.setProperty('line-height', '1.3', 'important')
        
        // Also style the percentage span inside
        const percentSpan = el.querySelector('span.font-medium') as HTMLElement | null
        if (percentSpan) {
          percentSpan.style.setProperty('font-size', '17px', 'important')
          percentSpan.style.setProperty('font-weight', '600', 'important')
        }
      }
    })

    // Increase gap between legend items for better readability
    document.querySelectorAll('.flex.items-center.gap-1\\.5.whitespace-nowrap').forEach(item => {
      const el = item as HTMLElement
      // Check if it's a legend item (contains a color dot and text)
      if (el.querySelector('.rounded-full') && el.querySelector('p')) {
        el.style.setProperty('gap', '8px', 'important')
      }
    })

    // Increase gap between legend item groups
    document.querySelectorAll('.flex.items-center.gap-x-3.gap-y-1.flex-wrap').forEach(container => {
      const el = container as HTMLElement
      el.style.setProperty('gap', '16px', 'important')
      el.style.setProperty('row-gap', '8px', 'important')
    })
  })
}
