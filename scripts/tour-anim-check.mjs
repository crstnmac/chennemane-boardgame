import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /^Tour$/i }).click();
await page.waitForTimeout(2000);
// step 2 sowing - wait for animation
await page.getByRole('button', { name: /^Next$/i }).click();
await page.waitForTimeout(1800);
await page.screenshot({ path: '.tmp-shots/tour-sow-a.png' });
await page.waitForTimeout(1600);
await page.screenshot({ path: '.tmp-shots/tour-sow-b.png' });
// step 3 capture
await page.getByRole('button', { name: /^Next$/i }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: '.tmp-shots/tour-cap.png' });
const cap = await page.locator('.tour-live-caption').textContent().catch(()=>'');
console.log('caption', cap);
await browser.close();
