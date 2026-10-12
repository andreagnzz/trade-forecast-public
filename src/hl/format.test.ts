import { describe, expect, it } from 'vitest';
import { pxDecimals, snapPrice, snapSize } from './format';

describe('HL formatters', () => {
  it.each([
    { px: 97123.456, szDecimals: 5, snapped: 97123 },
    { px: 3412.789, szDecimals: 4, snapped: 3412.7 },
    { px: 1.23456789, szDecimals: 5, snapped: 1.2 },
  ])('truncates $px to 5 significant figures and 6 - szDecimals decimals', (row) => {
    expect(snapPrice(row.px, row.szDecimals)).toBe(row.snapped);
  });

  it('truncates a size down to the lot', () => {
    expect(snapSize(0.123456, 5)).toBe(0.12345);
  });

  it.each([0.000009, 0, -1, Number.NaN, Infinity])(
    'returns 0 for a size below one lot (%s)',
    (sz) => {
      expect(snapSize(sz, 5)).toBe(0);
    },
  );

  it.each([0.01, 0, -5, Infinity])('returns 0 for a price that truncates to nothing (%s)', (px) => {
    expect(snapPrice(px, 5)).toBe(0);
  });

  it.each([
    { px: 83_352, szDecimals: 5, decimals: 0 },
    { px: 3412.7, szDecimals: 4, decimals: 1 },
    { px: 1.2345, szDecimals: 0, decimals: 4 },
    { px: 1.2345, szDecimals: 3, decimals: 3 },
  ])('shows $decimals decimals for $px with szDecimals $szDecimals', (row) => {
    expect(pxDecimals(row.px, row.szDecimals)).toBe(row.decimals);
  });
});
