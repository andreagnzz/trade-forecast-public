export interface Fill {
  tid: number;
  coin: string;
  time: number;
  side: 'buy' | 'sell';
  sz: number;
  startPosition: number;
  closedPnl: number;
  fee: number;
}

interface FundingPayment {
  time: number;
  usdc: number;
}

interface DayPnl {
  realized: number;
  funding: number;
  unrealized: number;
  total: number;
}

const DAY_MS = 86_400_000;

export function utcDayStart(ms: number): number {
  return ms - (ms % DAY_MS);
}

export function nextUtcDayStart(ms: number): number {
  return utcDayStart(ms) + DAY_MS;
}

// TWAP fills carry a zero hash, so tid is the only unique key.
export function dedupeByTid(fills: readonly Fill[]): Fill[] {
  const seen = new Set<number>();
  return fills.filter((f) => {
    if (seen.has(f.tid)) return false;
    seen.add(f.tid);
    return true;
  });
}

export function dayPnl(params: {
  fills: readonly Fill[];
  funding: readonly FundingPayment[];
  unrealizedPnl: number;
  now: number;
}): DayPnl {
  const start = utcDayStart(params.now);
  const isToday = (time: number) => utcDayStart(time) === start;
  // closedPnl excludes the fee, so net realized PnL is closedPnl - fee.
  const realized = dedupeByTid(params.fills.filter((f) => isToday(f.time))).reduce(
    (sum, f) => sum + f.closedPnl - f.fee,
    0,
  );
  const funding = params.funding.filter((p) => isToday(p.time)).reduce((sum, p) => sum + p.usdc, 0);
  return {
    realized,
    funding,
    unrealized: params.unrealizedPnl,
    total: realized + funding + params.unrealizedPnl,
  };
}

// An unknown PnL fails closed: a hard limit must lock rather than pass on NaN.
export function budgetRemainingUsd(limitUsd: number, dayPnlUsd: number): number {
  return Number.isFinite(dayPnlUsd) ? Math.max(0, limitUsd - Math.max(0, -dayPnlUsd)) : 0;
}
