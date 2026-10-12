import { describe, expect, it } from 'vitest';
import type { Fill } from '../core/budget';
import { incrementalFills, loadDayStats } from './accountData';

const NOON = Date.UTC(2026, 9, 12, 12);
const YESTERDAY = NOON - 86_400_000;

const fill = (
  tid: number,
  time: number,
  side: Fill['side'],
  startPosition: number,
  closedPnl = 0,
): Fill => ({
  tid,
  coin: 'BTC',
  time,
  side,
  sz: 0.001,
  startPosition,
  closedPnl,
  fee: 0.04,
});

describe('loadDayStats', () => {
  it('counts a round-trip opened yesterday and closed today, and today-only PnL', async () => {
    let fillsSince = 0;
    const stats = await loadDayStats(
      {
        fills: (since) => {
          fillsSince = since;
          return Promise.resolve([fill(1, YESTERDAY, 'buy', 0), fill(2, NOON, 'sell', 0.001, -1)]);
        },
        funding: () => Promise.resolve([{ time: NOON, usdc: -0.1 }]),
        unrealizedPnl: () => Promise.resolve(0.5),
      },
      NOON,
    );
    expect(fillsSince).toBe(NOON - 7 * 86_400_000);
    expect(stats.trips).toEqual([
      { coin: 'BTC', openTime: YESTERDAY, closeTime: NOON, netPnl: -1.08 },
    ]);
    expect(stats.dayPnlUsd).toBeCloseTo(-1 - 0.04 - 0.1 + 0.5);
  });
});

describe('incrementalFills', () => {
  it('fetches only what came after the last fill seen and keeps the window', async () => {
    const asked: number[] = [];
    const pages = [
      [fill(1, NOON - 10, 'buy', 0), fill(2, NOON - 5, 'sell', 0.001)],
      [fill(2, NOON - 5, 'sell', 0.001), fill(3, NOON, 'buy', 0)],
    ];
    const read = incrementalFills((since) => {
      asked.push(since);
      return Promise.resolve(pages.shift() ?? []);
    });
    expect((await read(YESTERDAY)).map((f) => f.tid)).toEqual([1, 2]);
    expect((await read(NOON - 6)).map((f) => f.tid)).toEqual([2, 3]);
    expect(asked).toEqual([YESTERDAY, NOON - 5]);
  });
});
