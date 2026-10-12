import { expect, test, type Page } from '@playwright/test';
import { openBracket, type Bracket } from '../../src/core/bracket/bracket';
import { nextUtcDayStart } from '../../src/core/budget';
import { callStore, numberIn, openTerminal, patchStore } from './terminal';

const MASTER = '0x0000000000000000000000000000000000000001';

async function capture(page: Page, state: string) {
  const desktop = page.viewportSize();
  await page.screenshot({ path: `test-results/states/${state}-desktop.png` });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `test-results/states/${state}-mobile.png`, fullPage: true });
  if (desktop) await page.setViewportSize(desktop);
}

async function filledBracket(page: Page, patch: Partial<Bracket>): Promise<Bracket> {
  const stopPx = numberIn(await page.getByTestId('stop').textContent());
  const { state } = openBracket({
    id: '000000000000000000000001',
    prefix: '7466',
    coin: 'BTC',
    side: 'long',
    entry: { type: 'ioc', px: Math.round(stopPx * 1.007) },
    size: 0.01,
    szDecimals: 5,
    minNotionalUsd: 10,
    stopPx,
    tpPx: Math.round(stopPx * 1.02),
    riskUsd: 50,
  });
  return {
    ...state,
    entry: { ...state.entry, status: 'done', size: 0.01 },
    sl: { ...state.sl, status: 'live' },
    filledSz: 0.01,
    ...patch,
  };
}

async function showBracket(page: Page, patch: Partial<Bracket>) {
  const bracket = await filledBracket(page, patch);
  await patchStore(page, 'account', { master: MASTER });
  await patchStore(page, 'execution', { view: { bracket, lastError: null } });
}

test('loading: the chart says what it is waiting for', async ({ page }) => {
  await page.route(/hyperliquid\.xyz\/info/, () => undefined);
  await page.goto('/');
  await expect(page.getByText('Loading BTC')).toBeVisible();
  await capture(page, 'loading');
});

test('error: market data failure offers a retry', async ({ page }) => {
  await page.route(/hyperliquid\.xyz\/info/, (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Market data unavailable');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await capture(page, 'error');
});

test('error: a start that fails after a newer one has loaded is ignored', async ({ page }) => {
  let held = 0;
  await page.route(/hyperliquid\.xyz\/info/, async (route) => {
    // The first start's three reads fail late; the second start's go through.
    if (held >= 3) return route.continue();
    held += 1;
    await new Promise((settle) => setTimeout(settle, 2000));
    return route.abort();
  });
  await page.goto('/');
  await expect.poll(() => held).toBe(3);
  await callStore(page, 'terminal', 'start');
  await expect(page.getByTestId('size')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await expect(page.getByText('Market data unavailable')).toBeHidden();
  await expect(page.getByTestId('size')).toBeVisible();
});

test('disconnected: a closed socket shows the reconnect banner', async ({ page }) => {
  await page.routeWebSocket(/hyperliquid/, (ws) => ws.close());
  await openTerminal(page);
  await expect(page.getByText('Market data disconnected. Reconnecting.')).toBeVisible();
  await patchStore(page, 'execution', { accountFeed: 'closed' });
  await expect(page.getByText('Account feed disconnected. Reconnecting.')).toBeVisible();
  await capture(page, 'disconnected');
});

test('disconnected: Send is refused while the market feed is down', async ({ page }) => {
  await page.routeWebSocket(/hyperliquid/, (ws) => ws.close());
  await openTerminal(page);
  await patchStore(page, 'account', { master: MASTER });
  const send = page.getByTestId('send');
  await expect(send).toHaveText('Market data disconnected');
  await expect(send).toBeDisabled();
});

test('attention: a crossing take-profit offers three choices', async ({ page }) => {
  await openTerminal(page);
  await showBracket(page, { attention: 'tp_would_cross' });
  for (const choice of ['Take profit at market', 'Rest at best maker price', 'Keep stop only']) {
    await expect(page.getByRole('button', { name: choice })).toBeVisible();
  }
  await capture(page, 'attention');
});

test('unprotected: an open position without a live stop offers a reduce-only close', async ({
  page,
}) => {
  await openTerminal(page);
  await showBracket(page, {
    sl: { seq: 5, maxSeq: 5, status: 'waiting', size: 0, retries: 5, closedSz: 0 },
    attention: 'sl_failed',
  });
  await expect(page.getByText(/UNPROTECTED: 0\.01 BTC/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close at market (reduce-only)' })).toBeInViewport({
    ratio: 1,
  });
  await capture(page, 'unprotected');
});

test('locked: Send is refused until 00:00 UTC', async ({ page }) => {
  await openTerminal(page);
  await patchStore(page, 'account', {
    master: MASTER,
    rulesState: {
      rules: { oneBullet: true, lossLimit: null },
      pending: null,
      lock: { reason: 'one_bullet', until: nextUtcDayStart(Date.now()) },
    },
  });
  await expect(page.getByTestId('send')).toHaveText('Locked until 00:00 UTC');
  await page.getByText('Daily rules').click();
  await capture(page, 'locked');
});

test('locked: arming one bullet after a losing round-trip today locks at once', async ({
  page,
}) => {
  await openTerminal(page);
  const now = Date.now();
  await patchStore(page, 'account', {
    master: MASTER,
    stats: {
      trips: [{ coin: 'BTC', openTime: now - 60_000, closeTime: now - 1000, netPnl: -0.4 }],
      dayPnlUsd: -0.4,
      asOf: now,
    },
  });
  await expect(page.getByTestId('send')).toHaveText('Send bracket');
  await page.getByText('Daily rules').click();
  await page.getByLabel(/One bullet/).check();
  await expect(page.getByTestId('send')).toHaveText('Locked until 00:00 UTC');
});

test('locked: a loss limit set after midnight ignores stats read the day before', async ({
  page,
}) => {
  await openTerminal(page);
  const yesterday = nextUtcDayStart(Date.now()) - 2 * 86_400_000 + 3_600_000;
  await patchStore(page, 'account', {
    master: MASTER,
    stats: { trips: [], dayPnlUsd: -60, asOf: yesterday },
  });
  await page.getByText('Daily rules').click();
  await page.getByRole('textbox', { name: /Daily loss limit/ }).fill('50');
  await page.getByRole('checkbox', { name: 'Hard', exact: true }).check();
  const apply = page.getByRole('button', { name: 'Apply' });
  await apply.click();
  await expect(page.getByTestId('send')).toHaveText('Send bracket');

  await patchStore(page, 'account', {
    stats: { trips: [], dayPnlUsd: -60, asOf: Date.now() },
  });
  await apply.click();
  await expect(page.getByTestId('send')).toHaveText('Locked until 00:00 UTC');
});

test('soft loss limit: reaching it warns and never refuses Send', async ({ page }) => {
  await openTerminal(page);
  await patchStore(page, 'account', {
    master: MASTER,
    stats: { trips: [], dayPnlUsd: -60, asOf: Date.now() },
  });
  await page.getByText('Daily rules').click();
  await page.getByRole('textbox', { name: /Daily loss limit/ }).fill('50');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Soft loss limit reached')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveText('Send bracket');
});

test('first run: the hint shows once and stays dismissed', async ({ page }) => {
  const chart = await openTerminal(page);
  const hint = page.getByText('Drag the red stop line');
  await expect(hint).toBeVisible();
  await capture(page, 'first-run');

  await page.mouse.click(chart.x + chart.width / 2, chart.y + chart.height / 2);
  await expect(hint).toBeHidden();
  await openTerminal(page);
  await expect(hint).toBeHidden();
});
