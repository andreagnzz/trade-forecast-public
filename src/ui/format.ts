import type { Sizing, SizingInput, SizingResult } from '../core/sizing';

const MINUS = '−';

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const wholeUsdFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const usd = (x: number) => usdFormat.format(Math.abs(x));
export const wholeUsd = (x: number) => wholeUsdFormat.format(x);
export const signedUsd = (x: number) => `${x < 0 ? MINUS : '+'}${usd(x)}`;
export const loss = (x: number) => `${MINUS}${usd(x)}`;
export const pct = (x: number) => `${x.toFixed(2)}%`;
export const rText = (rr: number) => `${rr < 0 ? MINUS : ''}${Math.abs(rr).toFixed(1)}R`;

const distancePct = (from: number, to: number) => pct((Math.abs(to - from) / from) * 100);

interface LineLabels {
  entry: string;
  stop: string;
  tp?: string;
}

export function lineLabels(sizing: Sizing, markPx: number, coin: string): LineLabels {
  const { entryPx, stopPx, size, notional, riskUsd, rewardUsd, rr } = sizing;
  const stop = [
    loss(riskUsd),
    `${distancePct(entryPx, stopPx)} from entry`,
    `${distancePct(markPx, stopPx)} from mark`,
  ].join(' · ');
  return {
    entry: `${String(size)} ${coin} · ${wholeUsd(notional)}`,
    stop,
    tp:
      rewardUsd === undefined || rr === undefined
        ? undefined
        : `${signedUsd(rewardUsd)} · ${rText(rr)}`,
  };
}

const priceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

export const price = (px: number) => priceFormat.format(px);

type SizingError = Extract<SizingResult, { ok: false }>['error'];

export function sizingErrorText(error: SizingError, side: SizingInput['side']): string {
  if (error.kind === 'invalid_input') return `invalid ${error.field}`;
  const [stopSide, tpSide] = side === 'long' ? ['below', 'above'] : ['above', 'below'];
  return error.leg === 'stop'
    ? `stop must be ${stopSide} entry`
    : `take-profit must be ${tpSide} entry`;
}
