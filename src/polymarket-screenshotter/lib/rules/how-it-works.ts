import { Page } from 'puppeteer'

/**
 * Removes the "How it works" banner and related elements.
 * Handles both dedicated banner containers and surgical removal from shared containers.
 */
export async function removeHowItWorks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hideElement = (el: HTMLElement | null) => {
      if (!el) return
      el.style.setProperty('display', 'none', 'important')
    }

    // Target only direct UI elements with "How it works" text (avoid large containers)
    const howTargets = Array.from(
      document.querySelectorAll('button, a, span')
    ).filter(el => /how it works/i.test((el as HTMLElement).textContent || '')) as HTMLElement[]

    howTargets.forEach(target => {
      const button = target.closest('button') as HTMLElement | null
      const link = target.closest('a') as HTMLElement | null
      const candidate = button || link || target

      // Never hide a container that also contains trading buttons.
      if (candidate.querySelector('.trading-button')) {
        hideElement(target)
      } else {
        hideElement(candidate)
      }
    })

    // Find and remove/hide "How it works" banner.
    // IMPORTANT: Some Polymarket layouts render "How it works" inside the *same fixed bar*
    // container as the Buy buttons. In those cases, we must hide only the banner sub-tree,
    // never the entire fixed container.
    const howSpans = Array.from(document.querySelectorAll('span')).filter(
      s => ((s as HTMLElement).textContent?.trim() || '') === 'How it works'
    ) as HTMLElement[]

    for (const span of howSpans) {
      // First: hide the closest clickable/container element (surgical).
      const clickable =
        (span.closest('button') as HTMLElement | null) ||
        (span.closest('a') as HTMLElement | null) ||
        (span.parentElement as HTMLElement | null)

      if (clickable) {
        if (clickable.querySelector('.trading-button')) {
          // Shared container with buy buttons — hide only the text + its immediate wrapper(s).
          span.style.setProperty('display', 'none', 'important')
          let p: HTMLElement | null = span.parentElement as HTMLElement | null
          for (let i = 0; i < 4 && p; i++) {
            if (!p.querySelector('.trading-button')) {
              p.style.setProperty('display', 'none', 'important')
              break
            }
            p = p.parentElement as HTMLElement | null
          }
        } else {
          clickable.style.setProperty('display', 'none', 'important')
        }
      } else {
        span.style.setProperty('display', 'none', 'important')
      }

      // Second: try to remove the dedicated banner container if it exists and is safe to remove.
      let el: HTMLElement | null = span as HTMLElement
      for (let i = 0; i < 10 && el; i++) {
        el = el.parentElement as HTMLElement | null
        if (!el) break

        const classes = el.className || ''
        const looksLikeBanner =
          classes.includes('rounded-t-lg') ||
          classes.includes('lg:hidden') ||
          (classes.includes('border-t') && classes.includes('py-3')) ||
          ((el.textContent || '').includes('How it works') && classes.includes('bg-background'))

        if (!looksLikeBanner) continue

        if (el.querySelector('.trading-button')) {
          // Shared ancestor with buy buttons — already hidden surgically above.
          break
        }

        console.log('[DEBUG] Final pass: removing', classes)
        el.remove()
        break
      }
    }
  })
}

/**
 * Second pass to catch late-injected banners.
 */
export async function removeHowItWorksSecondPass(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hideElement = (el: HTMLElement | null) => {
      if (!el) return
      el.style.setProperty('display', 'none', 'important')
    }

    const howTargets = Array.from(document.querySelectorAll('button, a, span, div'))
      .filter(el => /how it works/i.test((el as HTMLElement).textContent || '')) as HTMLElement[]

    howTargets.forEach(target => {
      const button = target.closest('button') as HTMLElement | null
      const link = target.closest('a') as HTMLElement | null
      const candidate = button || link || target

      if (candidate.querySelector('.trading-button')) {
        hideElement(target)
      } else {
        hideElement(candidate)
      }
    })
  })
}
