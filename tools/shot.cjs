// tools/shot.cjs — 无头截图（playwright-core + 共享 Chrome）
// 用法: node tools/shot.cjs <query> <out.png> [width] [height] [waitMs]
const path = require('path');
const { chromium } = require('/Users/csl/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

(async () => {
  const [, , q, out, w = '520', h = '900', waitMs = '1500'] = process.argv;
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  const url = 'file://' + path.resolve(__dirname, 'preview.html') + (q ? '?' + q : '');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(Number(waitMs));
  await page.screenshot({ path: path.resolve(out) });
  await browser.close();
  console.log('saved', out);
})().catch((e) => { console.error(e); process.exit(1); });
