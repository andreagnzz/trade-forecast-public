import { dayPnl, utcDayStart, type Fill } from '../core/budget';
import { closedRoundTrips } from '../core/roundtrips';
import type { DayStats } from '../core/rules';

const FLAT_LOOKBACK_MS = 7 * 86_400_000;

interface AccountReads {
  fills: (since: number) => Promise<Fill[]>;
  funding: (since: number) => Promise<{ time: number; usdc: number }[]>;
  unrealizedPnl: () => Promise<number>;
}

// Past fills never change: keep them by tid and fetch only what came after the last one seen.
export function incrementalFills<F extends Fill>(load: (since: number) => Promise<F[]>) {
  const cache = new Map<number, F>();
  let upTo = 0;
  return async (since: number): Promise<F[]> => {
    for (const f of await load(Math.max(since, upTo))) {
      cache.set(f.tid, f);
      upTo = Math.max(upTo, f.time);
    }
    for (const [tid, f] of cache) if (f.time < since) cache.delete(tid);
    return [...cache.values()];
  };
}

// A round-trip still open at midnight needs its fills back to the last flat point, so fills go
// back up to a week while PnL only counts today.
export async function loadDayStats(reads: AccountReads, now: number): Promise<DayStats> {
  const [fills, funding, unrealizedPnl] = await Promise.all([
    reads.fills(now - FLAT_LOOKBACK_MS),
    reads.funding(utcDayStart(now)),
    reads.unrealizedPnl(),
  ]);
  return {
    trips: closedRoundTrips(fills),
    dayPnlUsd: dayPnl({ fills, funding, unrealizedPnl, now }).total,
  };
}
