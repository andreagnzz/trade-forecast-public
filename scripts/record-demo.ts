import { rename } from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4173';
const size = { width: 1440, height: 900 };
const output = 'demo/demo.webm';

async function glide(page: Page, x: number, fromY: number, toY: number, ms: number) {
  const start = Date.now();
  let progress = 0;
  while (progress < 1) {
    progress = Math.min(1, (Date.now() - start) / ms);
    await page.mouse.move(x, fromY + (toY - fromY) * progress);
  }
}

async function dragLine(page: Page, key: '2' | '3', x: number, ys: number[], ms: number) {
  const [start, ...stops] = ys;
  if (start === undefined) return;
  await glide(page, x, start - 40, start, 400);
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
  await page.mouse.down();
  let from = start;
  for (const to of stops) {
    await glide(page, x, from, to, ms);
    from = to;
  }
  await page.mouse.up();
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: 'demo', size } });
const page = await context.newPage();
await page.goto(url);
await page.getByTestId('size').waitFor({ timeout: 15_000 });

const chart = await page.getByTestId('chart').boundingBox();
if (!chart) throw new Error('chart not rendered');
const x = chart.x + chart.width * 0.55;
const at = (ratio: number) => chart.y + chart.height * ratio;

await page.waitForTimeout(1500);
await dragLine(page, '2', x, [at(0.8), at(0.92), at(0.72), at(0.84)], 1600);
await page.waitForTimeout(800);
await dragLine(page, '3', x, [at(0.25), at(0.1), at(0.32), at(0.18)], 1600);
await page.waitForTimeout(800);
await page.keyboard.press('x');
await page.waitForTimeout(1800);
await page.keyboard.press('x');
await page.waitForTimeout(1200);

const video = page.video();
await context.close();
await browser.close();
if (video) await rename(await video.path(), output);
console.log(`recorded ${output}`);
