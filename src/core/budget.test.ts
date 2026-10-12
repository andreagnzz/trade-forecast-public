import { describe, expect, it } from 'vitest';
import {
  budgetRemainingUsd,
  dayPnl,
  dedupeByTid,
  nextUtcDayStart,
  utcDayStart,
  type Fill,
} from './budget';
import calibration from '../../fixtures/closedpnl-calibration.json';

const DAY = Date.UTC(2026, 9, 11);
const NEXT_DAY = DAY + 86_400_000;
const fill = (patch: Partial<Fill>): Fill => ({
  tid: 1,
  coin: 'BTC',
  time: DAY + 1000,
  side: 'buy',
  sz: 0.01,
  startPosition: 0,
  closedPnl: 0,
  fee: 0,
  ...patch,
});

describe('UTC day', () => {
  it.each([
    { name: 'midnight', ms: DAY, start: DAY },
    { name: 'last ms of the day', ms: NEXT_DAY - 1, start: DAY },
    { name: 'first ms of the next day', ms: NEXT_DAY, start: NEXT_DAY },
  ])('starts the trading day at 00:00 UTC ($name)', ({ ms, start }) => {
    expect(utcDayStart(ms)).toBe(start);
    expect(nextUtcDayStart(ms)).toBe(start + NEXT_DAY - DAY);
  });
});

describe('dedupeByTid', () => {
  it('keeps the first fill of each tid', () => {
    const fills = [fill({ tid: 1, fee: 1 }), fill({ tid: 2 }), fill({ tid: 1, fee: 9 })];
    expect(dedupeByTid(fills).map((f) => [f.tid, f.fee])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });
});

describe('dayPnl', () => {
  it('sums net realized PnL, funding and unrealized PnL for the current UTC day', () => {
    const pnl = dayPnl({
      fills: [
        fill({ tid: 1, time: DAY - 1, closedPnl: -100, fee: 1 }),
        fill({ tid: 2, time: DAY, closedPnl: 20, fee: 0.5 }),
        fill({ tid: 3, time: NEXT_DAY - 1, closedPnl: -40, fee: -0.1 }),
        fill({ tid: 3, time: NEXT_DAY - 1, closedPnl: -40, fee: -0.1 }),
        fill({ tid: 4, time: NEXT_DAY, closedPnl: -100, fee: 1 }),
      ],
      funding: [
        { time: DAY - 1, usdc: -5 },
        { time: DAY + 10, usdc: -1.25 },
      ],
      unrealizedPnl: -3,
      now: DAY + 5000,
    });
    expect(pnl.realized).toBeCloseTo(20 - 0.5 - 40 + 0.1, 9);
    expect(pnl.funding).toBe(-1.25);
    expect(pnl.unrealized).toBe(-3);
    expect(pnl.total).toBeCloseTo(-20.4 - 1.25 - 3, 9);
  });
});

describe('budgetRemainingUsd', () => {
  it.each([
    { name: 'a loss eats the limit', limit: 300, pnl: -250, remaining: 50 },
    { name: 'a gain does not raise the limit', limit: 300, pnl: 400, remaining: 300 },
    { name: 'a loss beyond the limit floors at zero', limit: 300, pnl: -310, remaining: 0 },
    { name: 'an unknown PnL counts as exhausted', limit: 300, pnl: Number.NaN, remaining: 0 },
  ])('$name', ({ limit, pnl, remaining }) => {
    expect(budgetRemainingUsd(limit, pnl)).toBe(remaining);
  });
});

describe('closedPnl calibration', () => {
  // A BTC round-trip opened and closed on testnet: closedPnl is the price PnL alone and the fee
  // comes separately, so net realized PnL is closedPnl - fee.
  it('excludes the fee', () => {
    const [open, close] = calibration.fills;
    if (!open || !close) throw new Error('calibration fixture incomplete');
    expect(close.closedPnl).toBeCloseTo((close.px - open.px) * close.sz, 9);
    const realized = dayPnl({
      fills: calibration.fills.map((f, tid) => ({
        ...f,
        tid,
        coin: calibration.coin,
        time: DAY,
        side: f.side === 'buy' ? 'buy' : 'sell',
      })),
      funding: [],
      unrealizedPnl: 0,
      now: DAY,
    }).realized;
    expect(realized).toBeCloseTo(close.closedPnl - open.fee - close.fee, 9);
  });
});
