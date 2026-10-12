import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Fill } from './budget';
import { closedRoundTrips } from './roundtrips';

let nextTid = 1;
const fill = (time: number, startPosition: number, signedSz: number, closedPnl = 0, fee = 0) =>
  ({
    tid: nextTid++,
    coin: 'BTC',
    time,
    side: signedSz > 0 ? 'buy' : 'sell',
    sz: Math.abs(signedSz),
    startPosition,
    closedPnl,
    fee,
  }) satisfies Fill;

describe('closedRoundTrips', () => {
  it('closes a round-trip when the position returns to flat, counting opening fees', () => {
    const trips = closedRoundTrips([fill(1, 0, 1, 0, 0.1), fill(2, 1, -1, -5, 0.1)]);
    expect(trips).toMatchObject([{ coin: 'BTC', openTime: 1, closeTime: 2 }]);
    expect(trips[0]?.netPnl).toBeCloseTo(-5.2, 9);
  });

  it('keeps a round-trip open across partial closes and adds', () => {
    const trips = closedRoundTrips([
      fill(1, 0, 2),
      fill(2, 2, -1, 3),
      fill(3, 1, 1),
      fill(4, 2, -2, -1),
    ]);
    expect(trips).toEqual([{ coin: 'BTC', openTime: 1, closeTime: 4, netPnl: 2 }]);
  });

  it('splits the fee of a flipping fill pro rata between the close and the new open', () => {
    const trips = closedRoundTrips([
      fill(1, 0, 1, 0, 0.1),
      fill(2, 1, -3, 2, 0.3),
      fill(3, -2, 2, -1, 0.2),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ openTime: 1, closeTime: 2 });
    expect(trips[0]?.netPnl).toBeCloseTo(2 - 0.1 - 0.1, 9);
    expect(trips[1]).toMatchObject({ openTime: 2, closeTime: 3 });
    expect(trips[1]?.netPnl).toBeCloseTo(-1 - 0.2 - 0.2, 9);
  });

  it('closes exactly on decimal sizes that do not sum to zero in floating point', () => {
    const trips = closedRoundTrips([fill(1, 0, 0.1), fill(2, 0.1, 0.2), fill(3, 0.3, -0.3)]);
    expect(trips).toHaveLength(1);
  });

  it('ignores fills before the first flat point of an incomplete history', () => {
    const trips = closedRoundTrips([
      fill(1, 1, 1),
      fill(2, 2, -2, 50),
      fill(3, 0, -1),
      fill(4, -1, 1, 4),
    ]);
    expect(trips).toEqual([{ coin: 'BTC', openTime: 3, closeTime: 4, netPnl: 4 }]);
  });

  it('tracks coins independently and sorts fills by time', () => {
    const eth = (f: Fill): Fill => ({ ...f, coin: 'ETH' });
    const trips = closedRoundTrips([
      fill(4, 1, -1, 1),
      eth(fill(3, 1, -1, -2)),
      eth(fill(2, 0, 1)),
      fill(1, 0, 1),
    ]);
    expect(trips).toEqual([
      { coin: 'ETH', openTime: 2, closeTime: 3, netPnl: -2 },
      { coin: 'BTC', openTime: 1, closeTime: 4, netPnl: 1 },
    ]);
  });

  it('chains same-millisecond pieces of one order by position, whatever the input order', () => {
    const open = fill(1, 0, 10);
    const first = fill(2, 10, -5, -20);
    const second = fill(2, 5, -5, 1);
    for (const fills of [
      [open, first, second],
      [open, second, first],
    ]) {
      expect(closedRoundTrips(fills)).toEqual([
        { coin: 'BTC', openTime: 1, closeTime: 2, netPnl: -19 },
      ]);
    }
  });

  it('chains same-millisecond fills of opposite-direction orders by position', () => {
    const open = fill(1, 0, 5);
    const add = fill(2, 5, 5, 0, 1);
    const stop = fill(2, 10, -10, -3, 1);
    for (const fills of [
      [open, add, stop],
      [open, stop, add],
    ]) {
      expect(closedRoundTrips(fills)).toEqual([
        { coin: 'BTC', openTime: 1, closeTime: 2, netPnl: -5 },
      ]);
    }
  });

  it('counts a fill delivered twice only once', () => {
    const open = fill(1, 0, 1, 0, 1);
    const trips = closedRoundTrips([open, open, fill(2, 1, -1, 0, 1)]);
    expect(trips[0]?.netPnl).toBe(-2);
  });

  it('accounts for every fill of a history that starts and ends flat', () => {
    const steps = fc.array(
      fc.record({
        lots: fc.integer({ min: -5, max: 5 }).filter((n) => n !== 0),
        closedPnl: fc.double({ min: -100, max: 100, noNaN: true }),
        fee: fc.double({ min: -0.1, max: 1, noNaN: true }),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(steps, (history) => {
        const fills: Fill[] = [];
        let position = 0;
        for (const step of history) {
          fills.push(fill(fills.length, position, step.lots, step.closedPnl, step.fee));
          position += step.lots;
        }
        if (position !== 0) fills.push(fill(fills.length, position, -position));
        const expected = fills.reduce((sum, f) => sum + f.closedPnl - f.fee, 0);
        const actual = closedRoundTrips(fills).reduce((sum, t) => sum + t.netPnl, 0);
        expect(actual).toBeCloseTo(expected, 6);
      }),
    );
  });
});
