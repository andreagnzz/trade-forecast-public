import { expect, test } from '@playwright/test';
import { findStopY, openTerminal } from './terminal';

test('dragging a line keeps frames under 20 ms at the 95th percentile', async ({ page }) => {
  const chart = await openTerminal(page);
  const x = chart.x + chart.width * 0.4;
  const stopY = await findStopY(page, x);
  const top = stopY - chart.height * 0.05;
  const bottom = stopY + chart.height * 0.05;

  // Records frame timestamps for 2 s while the drag below runs.
  const recording = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const frames: number[] = [];
        const tick = (t: number) => {
          frames.push(t);
          if (t - (frames[0] ?? t) < 2000) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );

  const stopBefore = await page.getByTestId('stop').textContent();
  await page.mouse.down();
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(x, i % 2 ? top : bottom, { steps: 30 });
  }
  await page.mouse.up();
  await expect(page.getByTestId('stop')).not.toHaveText(stopBefore ?? '');

  const frames = await recording;
  const intervals = frames.slice(1).map((t, i) => t - (frames[i] ?? t));
  const sorted = intervals.toSorted((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  test.info().annotations.push({
    type: 'frames',
    description: `${String(intervals.length)} frames, p95 ${p95.toFixed(1)} ms`,
  });
  expect(p95).toBeLessThan(20);
});
