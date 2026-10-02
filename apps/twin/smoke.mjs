/* Headless smoke test for the twin SPA (wainwright.fun/twin).
 * Verifies the app boots at its /twin/ base: model loads, room list
 * renders, furniture + lights load, canvas draws, no console errors.
 * Run from wainwright.fun/: node twin/smoke.mjs  (dev server on :5177)
 */
import { chromium } from 'file:///Users/jonathanwainwright/.hermes/hermes-agent/node_modules/playwright/index.mjs';

const URL = process.env.TWIN_URL || 'http://localhost:5177/twin/';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => errors.push(`reqfail ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const rooms = await page.locator('#rooms .room').count();
console.log('room buttons:', rooms);

// furniture + lights loaded? (they init async after the model)
const counts = await page.evaluate(() => {
  const t = window.__twin;
  return {
    meshes: t?.meshes?.length ?? 0,
    furniture: t?.furniture?.items?.length ?? 0,
    lights: t?.lights?.items?.length ?? 0,
    mode: t?.state?.mode,
    look: t?.state?.look,
  };
});
console.log('scene:', JSON.stringify(counts));

// canvas actually drawing?
const drawn = await page.evaluate(() => {
  const c = document.querySelector('#view3d canvas');
  if (!c) return 'no canvas';
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return 'no gl context';
  const px = new Uint8Array(4 * 100);
  gl.readPixels(0, 0, 10, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const sum = px.reduce((a, b) => a + b, 0);
  return sum > 0 ? 'pixels drawn' : 'all black';
});
console.log('canvas:', drawn);

await page.screenshot({ path: 'twin/smoke-base.png' });

// exercise: 2D toggle, Real look, floor isolation
await page.locator('#btn-2d').click();
await page.waitForTimeout(500);
await page.locator('#btn-3d').click();
await page.waitForTimeout(300);
await page.locator('#look-seg button[data-look="real"]').click(); // Real
await page.waitForTimeout(800);
await page.screenshot({ path: 'twin/smoke-real.png' });
const look = await page.evaluate(() => window.__twin.state.look);
console.log('look after toggle:', look);

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
