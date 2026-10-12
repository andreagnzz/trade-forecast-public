import { dedupeByTid, type Fill } from './budget';

export interface RoundTrip {
  coin: string;
  openTime: number;
  closeTime: number;
  netPnl: number;
}

const progress = (f: Fill) => (f.side === 'buy' ? f.startPosition : -f.startPosition);
const endPosition = (f: Fill) => f.startPosition + (f.side === 'buy' ? f.sz : -f.sz);

// Perp sizes have at most 6 decimals (prices get 6 - szDecimals), so fixing 6 turns start + sz
// back into the next fill's start.
const key = (position: number) => position.toFixed(6);

// A coin's fills in one ms form a path over positions, each starting where the last one ended.
// It starts at the coin's known position; else where more fills start than end, else at flat
// when the fills loop through it, else at the first start. Walking it as an Euler path
// (Hierholzer) never strands a fill the way picking the nearest start can. Fills off the path
// (missing or stray fills) are kept so no PnL is lost.
function chain(fills: Fill[], from: number | undefined): { path: Fill[]; rest: Fill[] } {
  const next = new Map<string, Fill[]>();
  const surplus = new Map<string, number>();
  // Reversed so pop() hands out the earliest fill of the sort.
  for (const f of [...fills].reverse()) {
    const start = key(f.startPosition);
    const list = next.get(start);
    if (list) list.push(f);
    else next.set(start, [f]);
    surplus.set(start, (surplus.get(start) ?? 0) + 1);
    surplus.set(key(endPosition(f)), (surplus.get(key(endPosition(f))) ?? 0) - 1);
  }
  const loopStart = next.has(key(0)) ? key(0) : fills[0] && key(fills[0].startPosition);
  const first =
    from !== undefined && next.has(key(from))
      ? key(from)
      : ([...surplus].find(([, n]) => n > 0)?.[0] ?? loopStart);
  const stack: { fill: Fill | null; at: string | undefined }[] = [{ fill: null, at: first }];
  const path: Fill[] = [];
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    const f = top.at === undefined ? undefined : next.get(top.at)?.pop();
    if (f) {
      stack.push({ fill: f, at: key(endPosition(f)) });
    } else {
      stack.pop();
      if (top.fill) path.push(top.fill);
    }
  }
  return { path: path.reverse(), rest: [...next.values()].flatMap((list) => list.reverse()) };
}

// Fills sharing a ms arrive in no guaranteed order, possibly from orders in opposite directions.
// The tid tie-break only makes the result independent of arrival order: when two same-ms
// round-trips have the same shape, positions alone cannot tell which open each close ends.
function executionOrder(fills: Fill[]): Fill[] {
  fills.sort((a, b) => a.time - b.time || progress(a) - progress(b) || a.tid - b.tid);
  const groups = new Map<string, { coin: string; fills: Fill[] }>();
  for (const f of fills) {
    const id = `${String(f.time)} ${f.coin}`;
    const group = groups.get(id);
    if (group) group.fills.push(f);
    else groups.set(id, { coin: f.coin, fills: [f] });
  }
  const position = new Map<string, number>();
  const ordered: Fill[] = [];
  for (const { coin, fills: group } of groups.values()) {
    const { path, rest } = chain(group, position.get(coin));
    const last = path.at(-1);
    if (last) position.set(coin, endPosition(last));
    ordered.push(...path, ...rest);
  }
  return ordered;
}

// Fills should reach back to the last flat point of each coin. A round-trip opened before the
// history starts at its first fill seen: its PnL is partial, but a losing close still counts.
export function closedRoundTrips(fills: readonly Fill[]): RoundTrip[] {
  const open = new Map<string, { openTime: number; netPnl: number }>();
  const closed: RoundTrip[] = [];
  for (const f of executionOrder(dedupeByTid(fills))) {
    const trip = open.get(f.coin) ?? { openTime: f.time, netPnl: 0 };
    const startAbs = Math.abs(f.startPosition);
    const reduces = f.startPosition !== 0 && (f.side === 'buy') !== f.startPosition > 0;
    if (!reduces || f.sz < startAbs) {
      const current = f.startPosition === 0 ? { openTime: f.time, netPnl: 0 } : trip;
      current.netPnl += f.closedPnl - f.fee;
      open.set(f.coin, current);
      continue;
    }
    // sz and startPosition are parsed from the same decimal strings, so equality is exact.
    const closingFee = f.sz === startAbs ? f.fee : (f.fee * startAbs) / f.sz;
    closed.push({
      coin: f.coin,
      openTime: trip.openTime,
      closeTime: f.time,
      netPnl: trip.netPnl + f.closedPnl - closingFee,
    });
    open.delete(f.coin);
    if (f.sz > startAbs) open.set(f.coin, { openTime: f.time, netPnl: closingFee - f.fee });
  }
  return closed;
}
