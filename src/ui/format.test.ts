import { describe, expect, it } from 'vitest';
import type { Sizing } from '../core/sizing';
import { lineLabels, sizingErrorText } from './format';

const sizing = (patch: Partial<Sizing>): Sizing => ({
  status: 'ok',
  binding: 'risk',
  entryPx: 60_120,
  expectedEntryPx: 60_000,
  stopPx: 59_280,
  tpPx: 61_440,
  size: 0.05,
  notional: 3006,
  leverage: 0.3,
  riskUsd: 50,
  riskPct: 0.5,
  priceRiskUsd: 42,
  feesAtStopUsd: 8,
  expectedRiskUsd: 44,
  rewardUsd: 120,
  rr: 2.4,
  warnings: [],
  ...patch,
});

describe('line labels', () => {
  it('measures the stop from the worst-case entry the dollar risk assumes', () => {
    expect(lineLabels(sizing({}), 60_090, 'BTC').stop).toBe(
      '−$50.00 · 1.40% from entry · 1.35% from mark',
    );
  });

  it('shows the net take-profit gain and R multiple', () => {
    expect(lineLabels(sizing({}), 60_090, 'BTC').tp).toBe('+$120.00 · 2.4R');
  });

  it('shows the entry size and notional', () => {
    expect(lineLabels(sizing({}), 60_090, 'BTC').entry).toBe('0.05 BTC · $3,006');
  });

  it('measures distances on a short the same way, stop above entry', () => {
    const short = sizing({ entryPx: 59_880, stopPx: 60_720, tpPx: 58_560 });
    expect(lineLabels(short, 60_000, 'BTC').stop).toBe(
      '−$50.00 · 1.40% from entry · 1.20% from mark',
    );
  });

  it('signs a take-profit that loses money after fees', () => {
    expect(lineLabels(sizing({ rewardUsd: -1.5, rr: -0.5 }), 60_000, 'BTC').tp).toBe(
      '−$1.50 · −0.5R',
    );
  });

  it('omits the take-profit label when there is no take-profit', () => {
    const noTp = sizing({ tpPx: undefined, rewardUsd: undefined, rr: undefined });
    expect(lineLabels(noTp, 60_000, 'BTC').tp).toBeUndefined();
  });
});

describe('sizing error text', () => {
  it.each([
    { side: 'long', leg: 'stop', text: 'stop must be below entry' },
    { side: 'long', leg: 'tp', text: 'take-profit must be above entry' },
    { side: 'short', leg: 'stop', text: 'stop must be above entry' },
    { side: 'short', leg: 'tp', text: 'take-profit must be below entry' },
  ] as const)('tells a $side trader where the $leg belongs', ({ side, leg, text }) => {
    expect(sizingErrorText({ kind: 'bad_geometry', leg }, side)).toBe(text);
  });

  it('names the invalid field', () => {
    expect(sizingErrorText({ kind: 'invalid_input', field: 'equity' }, 'long')).toBe(
      'invalid equity',
    );
  });
});
