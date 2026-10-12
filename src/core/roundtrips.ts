import { dedupeByTid, type Fill } from './budget';

export interface RoundTrip {
  coin: string;
  openTime: number;
  closeTime: number;
  netPnl: number;
}

const progress = (f: Fill) => (f.side === 'buy' ? f.startPosition : -f.startPosition);
const endPosition = (f: Fill) => f.startPosition + (f.side === 'buy' ? f.sz : -f.sz);

// Fills sharing a ms arrive in no guaranteed order, possibly from orders in opposite directions.
// Each coin's next fill is the one starting where its position stands; the signed-startPosition
// sort only breaks ties for a coin seen for the first time.
function executionOrder(fills: Fill[]): Fill[] {
  fills.sort((a, b) => a.time - b.time || progress(a) - progress(b));
  const byTime = new Map<number, Fill[]>();
  for (const f of fills) {
    const group = byTime.get(f.time);
    if (group) group.push(f);
    else byTime.set(f.time, [f]);
  }
  const position = new Map<string, number>();
  const gap = (f: Fill) => Math.abs(f.startPosition - (position.get(f.coin) ?? f.startPosition));
  const ordered: Fill[] = [];
  for (const group of byTime.values()) {
    while (group.length > 0) {
      const next = group.reduce((best, f) => (gap(f) < gap(best) ? f : best));
      group.splice(group.indexOf(next), 1);
      ordered.push(next);
      position.set(next.coin, endPosition(next));
    }
  }
  return ordered;
}

// Fills must reach back to the last flat point of each coin; earlier partial history is skipped.
export function closedRoundTrips(fills: readonly Fill[]): RoundTrip[] {
  const open = new Map<string, { openTime: number; netPnl: number }>();
  const closed: RoundTrip[] = [];
  for (const f of executionOrder(dedupeByTid(fills))) {
    const trip = open.get(f.coin);
    const startAbs = Math.abs(f.startPosition);
    const reduces = f.startPosition !== 0 && (f.side === 'buy') !== f.startPosition > 0;
    if (!reduces || f.sz < startAbs) {
      const current = f.startPosition === 0 ? { openTime: f.time, netPnl: 0 } : trip;
      if (!current) continue;
      current.netPnl += f.closedPnl - f.fee;
      open.set(f.coin, current);
      continue;
    }
    // sz and startPosition are parsed from the same decimal strings, so equality is exact.
    const closingFee = f.sz === startAbs ? f.fee : (f.fee * startAbs) / f.sz;
    if (trip) {
      closed.push({
        coin: f.coin,
        openTime: trip.openTime,
        closeTime: f.time,
        netPnl: trip.netPnl + f.closedPnl - closingFee,
      });
    }
    open.delete(f.coin);
    if (f.sz > startAbs) open.set(f.coin, { openTime: f.time, netPnl: closingFee - f.fee });
  }
  return closed;
}
