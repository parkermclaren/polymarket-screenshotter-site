import { Page } from 'puppeteer'

/**
 * Filters a multi-outcome event chart to show only a single outcome.
 *
 * When a user enters a specific market URL within an event (e.g., /event/.../will-jd-vance-win...),
 * this opens the chart settings, navigates to Chart Options, and unchecks all outcomes except the target one.
 *
 * @param outcomeSlug - The URL slug of the outcome to keep (e.g., 'will-jd-vance-win-the-2028-us-presidential-election')
 * @returns true if this is a multi-outcome page and filtering was applied, false otherwise
 */
export async function filterChartToSingleOutcome(page: Page, outcomeSlug: string): Promise<boolean> {
  // Step 1: Check if this is a multi-outcome event page
  const isMultiOutcome = await page.evaluate(() => {
    const legendItems = document.querySelectorAll('.size-2.rounded-full')
    return legendItems.length > 2
  })

  if (!isMultiOutcome) {
    console.log('[SingleOutcomeFilter] Not a multi-outcome page, skipping')
    return false
  }

  // Step 2: Click the settings gear icon to open the panel
  const gearClicked = await page.evaluate(() => {
    // Find the settings gear icon button
    const allSvgs = Array.from(document.querySelectorAll('svg[viewBox="0 0 18 18"]'))
    const gearSvg = allSvgs.find(svg => {
      const paths = svg.querySelectorAll('path')
      if (paths.length !== 2) return false
      const outerPath = paths[1]?.getAttribute('d') || ''
      return outerPath.includes('16.25') && outerPath.includes('9.35449')
    })

    if (!gearSvg) {
      console.log('[SingleOutcomeFilter] Could not find settings gear icon')
      return false
    }

    const gearButton = gearSvg.closest('button') as HTMLButtonElement | null
    if (!gearButton) {
      console.log('[SingleOutcomeFilter] Gear icon not inside a button')
      return false
    }

    console.log('[SingleOutcomeFilter] Clicking settings gear...')
    gearButton.click()
    return true
  })

  if (!gearClicked) {
    return false
  }

  // Wait for the settings panel to appear
  await new Promise(resolve => setTimeout(resolve, 300))

  // Step 3: Click on "Chart Options" to expand that section
  const chartOptionsClicked = await page.evaluate(() => {
    // Find "Chart Options" text and click it
    const spans = Array.from(document.querySelectorAll('span'))
    const chartOptionsSpan = spans.find(span =>
      (span as HTMLElement).textContent?.trim() === 'Chart Options'
    )

    if (!chartOptionsSpan) {
      console.log('[SingleOutcomeFilter] Could not find "Chart Options" text')
      return false
    }

    // Find the clickable parent (button or div)
    const clickable = chartOptionsSpan.closest('button') ||
                      chartOptionsSpan.closest('div[role="button"]') ||
                      chartOptionsSpan.closest('div.cursor-pointer') ||
                      chartOptionsSpan.parentElement

    if (clickable) {
      console.log('[SingleOutcomeFilter] Clicking Chart Options...')
      ;(clickable as HTMLElement).click()
      return true
    }

    return false
  })

  if (!chartOptionsClicked) {
    console.log('[SingleOutcomeFilter] Could not click Chart Options')
    // Try to close the panel
    await page.evaluate(() => {
      const chartArea = document.querySelector('#group-chart-container, canvas, h1') as HTMLElement | null
      if (chartArea) chartArea.click()
    })
    return false
  }

  // Wait for the Chart Options section to expand and show checkboxes
  await new Promise(resolve => setTimeout(resolve, 400))

  // Step 4: Find and toggle the outcome checkboxes
  const result = await page.evaluate((targetSlug: string) => {
    // Find all outcome checkboxes
    const checkboxes = Array.from(document.querySelectorAll('button[role="checkbox"]')) as HTMLButtonElement[]
    console.log('[SingleOutcomeFilter] Found', checkboxes.length, 'outcome checkboxes')

    if (checkboxes.length === 0) {
      console.log('[SingleOutcomeFilter] No checkboxes found')
      return { success: false, reason: 'no-checkboxes' }
    }

    const targetCheckboxId = `${targetSlug}-checkbox`
    let foundTarget = false
    let uncheckedCount = 0

    // Log all checkbox IDs for debugging
    console.log('[SingleOutcomeFilter] Looking for:', targetCheckboxId)
    console.log('[SingleOutcomeFilter] Available checkbox IDs:', checkboxes.map(c => c.id).join(', '))

    for (const checkbox of checkboxes) {
      const checkboxId = checkbox.id || ''
      const isTarget = checkboxId === targetCheckboxId
      const isChecked = checkbox.getAttribute('aria-checked') === 'true' ||
                        checkbox.getAttribute('data-state') === 'checked'

      if (isTarget) {
        foundTarget = true
        console.log('[SingleOutcomeFilter] Found target outcome:', checkboxId, 'checked:', isChecked)
        // If target is not checked, click it to enable it
        if (!isChecked) {
          checkbox.click()
        }
        continue
      }

      // For non-target outcomes that are checked, uncheck them by clicking the X button
      if (isChecked) {
        console.log('[SingleOutcomeFilter] Unchecking:', checkboxId)
        // Find the X button inside this checkbox row
        // The X icon has two diagonal lines
        const xButton = checkbox.querySelector('button') as HTMLButtonElement | null
        if (xButton) {
          xButton.click()
          uncheckedCount++
        } else {
          // Fallback: click the checkbox itself to toggle
          checkbox.click()
          uncheckedCount++
        }
      }
    }

    return {
      success: true,
      foundTarget,
      uncheckedCount,
      totalCheckboxes: checkboxes.length
    }
  }, outcomeSlug)

  // Small delay between operations
  await new Promise(resolve => setTimeout(resolve, 200))

  // Step 5: Close the settings panel by clicking outside
  await page.evaluate(() => {
    // Click on the page background or title to close the panel
    const title = document.querySelector('h1') as HTMLElement | null
    if (title) {
      title.click()
    } else {
      // Click on body
      document.body.click()
    }
  })

  // Wait for panel to close
  await new Promise(resolve => setTimeout(resolve, 300))

  // Hide any remaining bottom sheet/drawer that might still be visible
  await page.evaluate(() => {
    // Find and hide any drawer/sheet components
    const drawers = document.querySelectorAll('[data-state="open"], [class*="drawer"], [class*="sheet"], [class*="bottom-sheet"]')
    drawers.forEach(drawer => {
      (drawer as HTMLElement).style.setProperty('display', 'none', 'important')
    })

    // Also hide any overlay/backdrop
    const overlays = document.querySelectorAll('[class*="overlay"], [class*="backdrop"]')
    overlays.forEach(overlay => {
      (overlay as HTMLElement).style.setProperty('display', 'none', 'important')
    })

    // Hide the vaul-drawer if present (common drawer library)
    const vaulDrawer = document.querySelector('[vaul-drawer]')
    if (vaulDrawer) {
      (vaulDrawer as HTMLElement).style.setProperty('display', 'none', 'important')
    }
  })

  if (result.success) {
    console.log(`📊 Filtered chart to single outcome: ${outcomeSlug}`)
    console.log(`   Found target: ${result.foundTarget}, Unchecked: ${result.uncheckedCount}/${result.totalCheckboxes}`)
    if (!result.foundTarget) {
      console.log('⚠️ Warning: target outcome checkbox not found by ID')
    }
  } else {
    console.log(`⚠️ Could not filter chart: ${result.reason}`)
  }

  return result.success
}
