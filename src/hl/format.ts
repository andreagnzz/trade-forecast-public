import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';

// HL rejects a perp order worth less than $10, bracket legs included.
export const MIN_NOTIONAL_USD = 10;

// The SDK formatters truncate and throw on a zero or non-finite result. The sizing core
// expects 0 for a size below one lot (it reports below_min) and rejects a non-positive price.
export function snapPrice(px: number, szDecimals: number): number {
  if (!(px >= 10 ** -(6 - szDecimals) && Number.isFinite(px))) return 0;
  return Number(formatPrice(px, szDecimals, 'perp'));
}

// HL perp prices: at most 5 significant figures and 6 - szDecimals decimals.
export function pxDecimals(px: number, szDecimals: number): number {
  return Math.max(0, Math.min(4 - Math.floor(Math.log10(px)), 6 - szDecimals));
}

// A market exit crosses the touch by at most the slippage cap: the IOC limit price.
export function exitPx(
  quote: { bid: number; ask: number },
  isBuy: boolean,
  slippage: number,
  szDecimals: number,
): number {
  return snapPrice(isBuy ? quote.ask * (1 + slippage) : quote.bid * (1 - slippage), szDecimals);
}

export function snapSize(sz: number, szDecimals: number): number {
  if (!(sz >= 10 ** -szDecimals && Number.isFinite(sz))) return 0;
  return Number(formatSize(sz, szDecimals));
}

// The SDK validates requests, not responses: a NaN size or mark would make every comparison
// false and let a busy-coin or crossed-stop check pass.
export function parseNumber(text: string): number {
  const value = Number(text);
  if (text === '' || !Number.isFinite(value)) throw new Error(`not a number: ${text}`);
  return value;
}
