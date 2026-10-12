import { expect, test } from '@playwright/test';
import { findStopY, numberIn, openTerminal } from './terminal';

test('dragging the stop resizes the position without exceeding the risk', async ({ page }) => {
  const chart = await openTerminal(page);
  const x = chart.x + chart.width * 0.4;
  const stopY = await findStopY(page, x);
  const sizeBefore = await page.getByTestId('size').textContent();

  await page.mouse.down();
  await page.mouse.move(x, stopY + chart.height * 0.05, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByTestId('size')).not.toHaveText(sizeBefore ?? '');
  const risk = numberIn(await page.getByTestId('risk-at-stop').locator('strong').textContent());
  expect(risk).toBeGreaterThan(0);
  expect(risk).toBeLessThanOrEqual(50);
});

test('typing in the risk field never moves a line', async ({ page }) => {
  const chart = await openTerminal(page);
  await page.mouse.move(chart.x + chart.width * 0.4, chart.y + chart.height * 0.8);
  const stopBefore = await page.getByTestId('stop').textContent();

  const risk = page.locator('#risk-input');
  await risk.fill('');
  await risk.press('1');
  await risk.press('2');
  await risk.press('Enter');

  await expect(risk).toHaveValue('12');
  await expect(page.getByTestId('stop')).toHaveText(stopBefore ?? '');
});
