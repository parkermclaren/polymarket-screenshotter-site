import { Page } from 'puppeteer'

/**
 * Hides headers, nav bars, and unwanted page sections.
 */
export async function hideUnwantedElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    // HIDE TOP HEADER (Polymarket logo, Log In, Sign Up)
    const headers = document.querySelectorAll('header')
    headers.forEach(header => {
      const text = (header as HTMLElement).textContent || ''
      if (text.includes('Log In') || text.includes('Sign Up')) {
        ;(header as HTMLElement).style.display = 'none'
      }
    })

    // HIDE STICKY CATEGORY NAV (Trending, Breaking, New, etc.)
    document.querySelectorAll('nav').forEach(nav => {
      const style = window.getComputedStyle(nav as HTMLElement)
      const text = (nav as HTMLElement).textContent || ''
      if (style.position === 'sticky' && (text.includes('Trending') || text.includes('Breaking'))) {
        ;(nav as HTMLElement).style.display = 'none'
      }
    })

    // HIDE CONTENT SECTIONS BELOW CHART
    const sectionsToHide = ['Order Book', 'Market Context', 'About', 'Comments', 'Top Holders', 'Activity']
    const allElements = document.querySelectorAll('main *')
    allElements.forEach(el => {
      const element = el as HTMLElement
      if (element.tagName === 'BUTTON' || element.tagName === 'DIV' || element.tagName === 'H2' || element.tagName === 'H3') {
        const text = element.textContent?.trim() || ''
        for (const section of sectionsToHide) {
          if (text === section || text.startsWith(section)) {
            let parent = element.parentElement
            for (let i = 0; i < 5 && parent; i++) {
              const rect = parent.getBoundingClientRect()
              if (rect.height < 200 && rect.height > 30) {
                parent.style.display = 'none'
                break
              }
              parent = parent.parentElement
            }
          }
        }
      }
    })

    // Hide the "Add a comment" composer (often shown without a "Comments" header)
    const commentInputs = Array.from(
      document.querySelectorAll('input[placeholder*="comment" i], textarea[placeholder*="comment" i]')
    ) as HTMLElement[]
    commentInputs.forEach(input => {
      const container =
        (input.closest('div[role="group"]') as HTMLElement | null) ||
        (input.closest('form') as HTMLElement | null) ||
        (input.closest('div') as HTMLElement | null)
      if (container) {
        container.style.display = 'none'
      }
    })

    // Hide any visible "Add a comment" text block
    document.querySelectorAll('div, span, p').forEach(el => {
      const text = (el as HTMLElement).textContent?.trim().toLowerCase() || ''
      if (text === 'add a comment') {
        const container =
          (el.closest('div[role="group"]') as HTMLElement | null) ||
          (el.closest('form') as HTMLElement | null) ||
          (el.closest('div') as HTMLElement | null)
        if (container) {
          container.style.display = 'none'
        }
      }
    })

    // HIDE FIXED BOTTOM NAV ELEMENTS (keep only Buy buttons)
    const fixedNavs = Array.from(document.querySelectorAll('nav')).filter(nav => {
      const style = window.getComputedStyle(nav as HTMLElement)
      return style.position === 'fixed'
    })

    fixedNavs.forEach(nav => {
      const navEl = nav as HTMLElement
      const hasBuyButtons = !!navEl.querySelector('.trading-button')

      if (hasBuyButtons) {
        // This is the Buy button nav - hide non-button sections
        const allChildren = navEl.querySelectorAll('*')
        allChildren.forEach(child => {
          const childEl = child as HTMLElement
          const text = childEl.textContent?.trim() || ''
          if (text === 'How it works' || text.includes('How it works')) {
            const candidate =
              (childEl.closest('div.rounded-t-lg') as HTMLElement | null) ||
              (childEl.closest('div[class*="rounded-t"]') as HTMLElement | null) ||
              (childEl.closest('div[class*="border-t"]') as HTMLElement | null) ||
              (childEl.parentElement as HTMLElement | null)

            if (candidate && !candidate.querySelector('.trading-button')) {
              candidate.style.display = 'none'
            }
          }
        })
        
        // Hide the bottom tab bar (Home, Search, Breaking, More)
        const bottomTabs = navEl.querySelectorAll('a[href="/"], a[href*="search"], a[href*="breaking"]')
        bottomTabs.forEach(tab => {
          let parent = (tab as HTMLElement).parentElement
          while (parent && parent !== navEl) {
            if (parent.querySelector('.trading-button')) {
              break
            }
            if (parent.parentElement === navEl || parent.parentElement?.parentElement === navEl) {
              parent.style.display = 'none'
              break
            }
            parent = parent.parentElement
          }
        })
      } else {
        // Nav without Buy buttons - hide entirely
        navEl.style.display = 'none'
      }
    })

    // ADJUST MAIN CONTENT - reduce top padding
    const main = document.querySelector('main')
    if (main) {
      ;(main as HTMLElement).style.marginTop = '0'
      ;(main as HTMLElement).style.paddingTop = '8px'
    }
    document.body.style.paddingTop = '0'
    document.body.style.marginTop = '0'

    // Target the mobile wrapper that adds big gap
    const paddedWrappers = document.querySelectorAll('main .px-4.pt-4') as NodeListOf<HTMLElement>
    paddedWrappers.forEach(el => {
      el.style.paddingTop = '10px'
    })

    // Target the sticky title container
    const stickyTitleWrappers = Array.from(document.querySelectorAll('main .sticky')) as HTMLElement[]
    stickyTitleWrappers.forEach(el => {
      if (el.querySelector('h1')) {
        el.style.paddingTop = '8px'
        el.style.paddingBottom = '8px'
        el.style.position = 'relative'
        el.style.top = '0'
      }
    })

    // Hide popups/modals
    document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"]').forEach(el => {
      ;(el as HTMLElement).style.display = 'none'
    })
  })
}
