import { Page } from 'puppeteer'

/**
 * For multi-outcome event pages, hides the individual market cards below the chart
 * and adds a "Trade" button at the bottom.
 * 
 * Returns true if this is a multi-outcome event page, false otherwise.
 */
export async function cropToEventChart(page: Page): Promise<boolean> {
  const isMultiOutcome = await page.evaluate(() => {
    // Detect if this is a multi-outcome event page by checking for:
    // 1. Multiple outcome legend items (colored dots with percentages)
    // 2. No standard Buy Yes/Buy No buttons (those indicate a single market)
    
    const legendItems = document.querySelectorAll('.size-2.rounded-full')
    const hasMultipleOutcomes = legendItems.length > 2 // More than Yes/No
    
    // Check if there are standard buy buttons (single market page)
    const buyButtons = Array.from(document.querySelectorAll('.trading-button-text'))
      .filter(el => {
        const text = (el as HTMLElement).textContent?.toLowerCase() || ''
        return text.includes('buy yes') || text.includes('buy no')
      })
    const hasBuyYesNo = buyButtons.length >= 2
    
    if (!hasMultipleOutcomes || hasBuyYesNo) {
      console.log('[EventCrop] Not a multi-outcome event page, skipping')
      return false
    }
    
    console.log('[EventCrop] Detected multi-outcome event page with', legendItems.length, 'outcomes')
    
    // Find the volume row
    const volText = Array.from(document.querySelectorAll('p')).find(p =>
      ((p as HTMLElement).textContent || '').includes('Vol.')
    ) as HTMLElement | undefined
    
    const volRow = volText?.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null
      || volText?.closest('div.flex.w-full') as HTMLElement | null
    
    if (!volRow) {
      console.log('[EventCrop] Could not find volume row')
      return false
    }
    
    console.log('[EventCrop] Found volume row')
    
    // Find the main chart section container by walking up from the volume row
    let chartSection: HTMLElement | null = volRow
    for (let i = 0; i < 8 && chartSection; i++) {
      chartSection = chartSection.parentElement as HTMLElement | null
      if (!chartSection) break
      
      const classes = chartSection.className || ''
      if (classes.includes('min-h-[var(--chart-height)]') || 
          classes.includes('min-h-\\[var\\(--chart-height\\)\\]')) {
        console.log('[EventCrop] Found chart section container via min-h class')
        break
      }
      
      const hasChart = chartSection.querySelector('canvas, svg[class*="recharts"], #group-chart-container')
      const hasLegend = chartSection.querySelectorAll('.size-2.rounded-full').length > 0
      const hasVolRow = chartSection.contains(volRow)
      
      if (hasChart && hasLegend && hasVolRow) {
        console.log('[EventCrop] Found chart section container via content detection')
        break
      }
    }
    
    if (!chartSection) {
      console.log('[EventCrop] Could not find chart section container')
      return false
    }
    
    // Hide everything that comes AFTER the chart section in the DOM
    let sibling = chartSection.nextElementSibling as HTMLElement | null
    while (sibling) {
      sibling.style.setProperty('display', 'none', 'important')
      console.log('[EventCrop] Hiding sibling element')
      sibling = sibling.nextElementSibling as HTMLElement | null
    }
    
    // Hide any existing fixed bottom bar
    const fixedBars = Array.from(document.querySelectorAll('nav, div[class*="fixed"]')).filter(el => {
      const style = window.getComputedStyle(el as HTMLElement)
      return style.position === 'fixed' && style.bottom === '0px'
    }) as HTMLElement[]
    
    fixedBars.forEach(bar => {
      if (bar.querySelector('.trading-button') || bar.querySelector('button')) {
        bar.style.setProperty('display', 'none', 'important')
        console.log('[EventCrop] Hiding fixed bottom bar')
      }
    })
    
    // Hide individual market cards that appear below the chart
    const marketCards = Array.from(document.querySelectorAll('div.flex.justify-between.z-1')) as HTMLElement[]
    const chartRect = chartSection.getBoundingClientRect()
    marketCards.forEach(card => {
      const cardRect = card.getBoundingClientRect()
      if (cardRect.top > chartRect.bottom - 50) {
        // Try to find the outer card container to hide the whole thing (borders, padding, etc.)
        // The user provided snippet shows it has class "group" and "border-b"
        const outerCard = card.closest('div.group.border-b') as HTMLElement | null
          || card.closest('div.group') as HTMLElement | null
        
        if (outerCard) {
             outerCard.style.setProperty('display', 'none', 'important')
             console.log('[EventCrop] Hiding outer market card')
        } else {
             card.style.setProperty('display', 'none', 'important')
             console.log('[EventCrop] Hiding inner market card')
        }
      }
    })
    
    // Hide any remaining content below the chart
    const chartBottom = chartSection.getBoundingClientRect().bottom
    const allElements = Array.from(document.querySelectorAll('main > div > div > div')) as HTMLElement[]
    allElements.forEach(el => {
      const rect = el.getBoundingClientRect()
      if (rect.top > chartBottom + 20 && !el.contains(chartSection)) {
        el.style.setProperty('display', 'none', 'important')
      }
    })
    
    // CREATE THE TRADE BUTTON using Polymarket's native button styling
    // Check if we already added it
    if (document.getElementById('event-trade-button-container')) {
      console.log('[EventCrop] Trade button already exists')
      return true
    }
    
    // Create a fixed bottom bar matching Polymarket's style - extra tall to cover any buttons above
    const tradeButtonContainer = document.createElement('div')
    tradeButtonContainer.id = 'event-trade-button-container'
    tradeButtonContainer.style.cssText = `
      position: fixed !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      background: white !important;
      padding: 20px 20px 32px 20px !important;
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
      z-index: 99999 !important;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.08) !important;
    `
    
    // Create the button wrapper span (matches Polymarket's structure)
    const buttonWrapper = document.createElement('span')
    buttonWrapper.style.cssText = `
      display: flex !important;
      height: 72px !important;
      flex: 1 1 0% !important;
      width: 100% !important;
      max-width: 100% !important;
    `
    
    // Create the actual button using Polymarket's trading-button classes
    const tradeButton = document.createElement('button')
    tradeButton.className = 'trading-button'
    tradeButton.setAttribute('data-color', 'blue')
    tradeButton.setAttribute('data-selected', 'true')
    tradeButton.setAttribute('data-three-dee', '')
    tradeButton.setAttribute('data-tapstate', 'rest')
    tradeButton.type = 'button'
    tradeButton.style.cssText = `
      --btn-shadow-height: 6px;
      --btn-hover-offset: 1.5px;
      --btn-click-damping: 2px;
      --btn-height: 66px;
      height: 72px !important;
      min-height: 72px !important;
    `
    
    // Create the inner text span
    const buttonText = document.createElement('span')
    buttonText.className = 'trading-button-text'
    buttonText.setAttribute('data-selected', 'true')
    buttonText.setAttribute('data-three-dee', '')
    buttonText.setAttribute('data-tapstate', 'rest')
    
    // Inner content - larger text
    buttonText.innerHTML = `
      <span class="flex items-center gap-3">
        <span class="flex flex-col items-center gap-0.5 relative">
          <span class="flex items-center">
            <span class="whitespace-nowrap font-semibold text-inherit!" style="width: fit-content; font-size: 22px !important;">
              Trade
            </span>
          </span>
        </span>
      </span>
    `
    
    tradeButton.appendChild(buttonText)
    buttonWrapper.appendChild(tradeButton)
    tradeButtonContainer.appendChild(buttonWrapper)
    document.body.appendChild(tradeButtonContainer)
    
    console.log('[EventCrop] Added Trade button with native Polymarket styling')
    
    return true
  })
  
  return isMultiOutcome
}

export async function measureEventChartHeight(page: Page): Promise<number | null> {
  const height = await page.evaluate(() => {
    // Find the title
    const title = document.querySelector('h1') as HTMLElement | null
    if (!title) return null
    
    // Find the volume row (bottom of what we want to show)
    const volText = Array.from(document.querySelectorAll('p')).find(p =>
      ((p as HTMLElement).textContent || '').includes('Vol.')
    ) as HTMLElement | undefined
    
    const volRow = volText?.closest('div.flex.w-full.flex-1.box-border.z-1') as HTMLElement | null
      || volText?.closest('div.flex.w-full') as HTMLElement | null
    
    if (!volRow) return null
    
    // Also find time buttons to ensure we capture the full height of that row
    const timeButtons = document.querySelector('div.flex.items-center.gap-1') as HTMLElement | null
    
    const titleRect = title.getBoundingClientRect()
    const volRect = volRow.getBoundingClientRect()
    
    // Determine the true bottom of the content
    // We prefer to use the main chart section container's bottom if found
    let contentBottom = volRect.bottom
    
    // Try to find the main chart section container
    const chartSection = volRow.closest('div.min-h-\\[var\\(--chart-height\\)\\]') as HTMLElement | null 
        || volRow.closest('div[class*="min-h-"]') as HTMLElement | null
        || volRow.parentElement as HTMLElement | null
    
    if (chartSection) {
        const chartRect = chartSection.getBoundingClientRect()
        contentBottom = Math.max(contentBottom, chartRect.bottom)
    }
    
    if (timeButtons) {
        const timeRect = timeButtons.getBoundingClientRect()
        contentBottom = Math.max(contentBottom, timeRect.bottom)
    }
    
    // Calculate content height (Title top to Volume Row bottom)
    // We use scrollY because getBoundingClientRect is relative to viewport
    const scrollY = window.scrollY || 0
    const contentTop = titleRect.top + scrollY
    const absoluteContentBottom = contentBottom + scrollY
    
    // Height of our fixed Trade button container
    // Padding: 20px top + 32px bottom = 52px
    // Button: 72px
    // Total: 124px
    const tradeButtonHeight = 124
    
    // Add a small buffer for visual separation (0 for perfect alignment)
    const buffer = 0
    
    // We need the viewport to be tall enough to cover from the top of the page (y=0)
    // down to the bottom of the content, plus the fixed button at the bottom.
    // If we used contentHeight (bottom - top), we'd lose the space above the title (contentTop).
    const totalHeight = absoluteContentBottom + tradeButtonHeight + buffer
    
    console.log('[EventCrop] Measured:', { 
      absoluteContentBottom,
      tradeButtonHeight, 
      totalHeight,
      titleTop: contentTop,
      volBottom: absoluteContentBottom
    })
    
    return Math.ceil(totalHeight)
  })
  
  return height
}
