import { Page } from 'puppeteer'

/**
 * Clicks the specified time range tab and waits for the chart to update.
 */
export async function selectTimeRange(
  page: Page,
  timeRange: '1h' | '6h' | '1d' | '1w' | '1m' | 'max'
): Promise<void> {
  console.log(`📊 Selecting ${timeRange.toUpperCase()} time range...`)

  try {
    const tabSelector = `button[role="tab"]`
    const tabs = await page.$$(tabSelector)

    for (const tab of tabs) {
      const text = await tab.evaluate(el => el.textContent?.trim().toLowerCase() || '')
      if (text === timeRange) {
        console.log(`✓ Clicking ${timeRange.toUpperCase()} tab...`)
        
        // Scroll the tab into view
        await tab.evaluate(el => {
          ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
        })

        let clickMethod: 'puppeteer' | 'dom' = 'puppeteer'
        try {
          await tab.click({ delay: 20 })
        } catch (clickErr) {
          clickMethod = 'dom'
          console.log('⚠️ Puppeteer click failed, falling back to DOM click:', clickErr)
          await tab.evaluate(el => {
            ;(el as HTMLElement).click()
          })
        }

        await page
          .waitForNetworkIdle({ idleTime: 300, timeout: 4000 })
          .catch(() => console.log('⚠️ Network idle timeout after tab click'))

        console.log(`✓ Clicked ${timeRange.toUpperCase()} tab via ${clickMethod} and data loaded`)
        break
      }
    }
  } catch (err) {
    console.log('⚠️ Could not click time range tab:', err)
  }
}
