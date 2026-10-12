import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sizePosition, type Sizing, type SizingInput } from './sizing';

const truncateTo = (decimals: number) => (x: number) =>
  Math.trunc(x * 10 ** decimals) / 10 ** decimals;

const btcLong: SizingInput = {
  side: 'long',
  entry: { kind: 'market', refPx: 60000, maxSlippage: 0.002 },
  stopPx: 59400,
  tpPx: 61500,
  risk: { kind: 'usd', value: 50 },
  equity: 10000,
  stopSlippageBuffer: 0.001,
  spec: { szDecimals: 5, maxLeverage: 40, minNotionalUsd: 10 },
  fees: { taker: 0.00045, maker: 0.00015 },
  snapPrice: truncateTo(1),
  snapSize: truncateTo(5),
};

function sizeOk(input: SizingInput): Sizing {
  const sized = sizePosition(input);
  if (!sized.ok) throw new Error(`unexpected error ${JSON.stringify(sized.error)}`);
  return sized.value;
}

describe('sizePosition', () => {
  it('sizes a market long at the IOC limit price with fees in the risk', () => {
    const sized = sizeOk(btcLong);
    // L = (60120 - 59400) + 60120 * 0.00045 + 59400 * (0.001 + 0.00045 * 1.001) = 833.21073
    expect(sized.entryPx).toBe(60120);
    expect(sized.expectedEntryPx).toBe(60000);
    expect(sized.size).toBe(0.06);
    expect(sized.riskUsd).toBeCloseTo(0.06 * 833.21073, 9);
    expect(sized.priceRiskUsd).toBeCloseTo(0.06 * 720, 9);
    expect(sized.feesAtStopUsd).toBeCloseTo(sized.riskUsd - sized.priceRiskUsd, 9);
    expect(sized.expectedRiskUsd).toBeLessThan(sized.riskUsd);
    expect(sized.status).toBe('ok');
    expect(sized.binding).toBe('risk');
    expect(sized.warnings).toEqual([]);
  });

  it('values a market short at the IOC limit below the best bid', () => {
    const sized = sizeOk({
      ...btcLong,
      side: 'short',
      stopPx: 60600,
      tpPx: 58500,
    });
    expect(sized.entryPx).toBe(59880);
  });

  it('charges the taker fee on the worst stop fill of a short', () => {
    const sized = sizeOk({
      ...btcLong,
      side: 'short',
      stopPx: 60600,
      tpPx: 58500,
      snapSize: (sz) => sz,
    });
    const stopFillPx = 60600 * 1.001;
    const worstLoss =
      sized.size * (stopFillPx - sized.entryPx + sized.entryPx * 0.00045 + stopFillPx * 0.00045);
    expect(worstLoss).toBeLessThanOrEqual(50 * (1 + 1e-12));
  });

  it('uses the maker fee only for a non-marketable limit entry', () => {
    const limit = { ...btcLong, entry: { kind: 'limit', px: 60000, marketable: false } } as const;
    const resting = sizeOk(limit);
    const marketable = sizeOk({ ...limit, entry: { ...limit.entry, marketable: true } });
    expect(resting.size).toBeGreaterThan(marketable.size);
    expect(resting.entryPx).toBe(60000);
  });

  it('reads a percent-of-equity risk as percent', () => {
    const sized = sizeOk({ ...btcLong, risk: { kind: 'pct_equity', value: 0.5 } });
    expect(sized.size).toBe(sizeOk(btcLong).size);
    expect(sized.riskPct).toBeCloseTo((sized.riskUsd / 10000) * 100, 9);
  });

  it('reports reward net of entry and maker TP fees, and the R multiple', () => {
    const sized = sizeOk(btcLong);
    const rewardPerUnit = 61500 - 60120 - 60120 * 0.00045 - 61500 * 0.00015;
    expect(sized.rewardUsd).toBeCloseTo(sized.size * rewardPerUnit, 9);
    expect(sized.rr).toBeCloseTo(rewardPerUnit / 833.21073, 9);
  });

  it('warns when the TP sits between the expected entry and the worst fill', () => {
    const sized = sizeOk({ ...btcLong, tpPx: 60050 });
    expect(sized.rewardUsd).toBeLessThan(0);
    expect(sized.warnings).toEqual(['tp_inside_expected_entry']);
  });

  it('leaves reward and R multiple undefined without a TP', () => {
    const sized = sizeOk({ ...btcLong, tpPx: undefined });
    expect(sized.rewardUsd).toBeUndefined();
    expect(sized.rr).toBeUndefined();
  });

  it('caps the risk at the remaining daily budget', () => {
    const sized = sizeOk({ ...btcLong, risk: { kind: 'usd', value: 100 }, budgetRemainingUsd: 50 });
    expect(sized.binding).toBe('budget');
    expect(sized.size).toBe(sizeOk(btcLong).size);
  });

  it('returns size 0 and no proposal when the budget is exhausted', () => {
    const sized = sizeOk({ ...btcLong, budgetRemainingUsd: 0 });
    expect(sized).toMatchObject({ status: 'budget_exhausted', binding: 'budget', size: 0 });
    expect(sized.riskUsd).toBe(0);
    expect(sized.minProposal).toBeUndefined();
  });

  it.each([
    { name: 'maxTradeSz', patch: { maxTradeSz: 0.0123456 }, binding: 'max_trade_sz', sz: 0.01234 },
    {
      name: 'leverage',
      patch: { spec: { ...btcLong.spec, maxLeverage: 0.25 } },
      binding: 'leverage',
      sz: 0.04158,
    },
  ] as const)(
    'caps the size at $name and names the binding constraint',
    ({ patch, binding, sz }) => {
      const sized = sizeOk({ ...btcLong, ...patch });
      expect(sized.binding).toBe(binding);
      expect(sized.size).toBe(sz);
      expect(sized.status).toBe('ok');
    },
  );

  it.each([
    { side: 'long', stopPx: 59400, tpPx: 61500, cheapestLegPx: 60000 },
    { side: 'short', stopPx: 60600, tpPx: 58500, cheapestLegPx: 58500 },
  ] as const)(
    'flags a $side below the minimum notional on its cheapest leg and proposes the smallest valid size',
    ({ side, stopPx, tpPx, cheapestLegPx }) => {
      const sized = sizeOk({ ...btcLong, side, stopPx, tpPx, risk: { kind: 'usd', value: 0.1 } });
      expect(sized.status).toBe('below_min');
      expect(sized.binding).toBe('min_notional');
      expect(sized.size).toBeLessThan(0.0002);
      const proposal = sized.minProposal;
      expect(proposal?.size).toBe(Math.ceil((10 / cheapestLegPx) * 1e5) / 1e5);
      expect(proposal && proposal.size * cheapestLegPx).toBeGreaterThanOrEqual(10);
      expect(proposal?.riskUsd).toBeGreaterThan(sized.riskUsd);
    },
  );

  it('ignores the stop price in the minimum notional, since the position SL has no size', () => {
    const sized = sizeOk({ ...btcLong, stopPx: 54000, risk: { kind: 'usd', value: 1.06 } });
    expect(sized.size).toBe(0.00017);
    expect(sized.size * sized.stopPx).toBeLessThan(10);
    expect(sized.status).toBe('ok');
  });

  it('omits the proposal when the minimum size would exceed the size cap', () => {
    const sized = sizeOk({ ...btcLong, risk: { kind: 'usd', value: 0.1 }, maxTradeSz: 0.0001 });
    expect(sized.status).toBe('below_min');
    expect(sized.minProposal).toBeUndefined();
  });

  it('omits the proposal when its risk would exceed the remaining budget', () => {
    const sized = sizeOk({ ...btcLong, budgetRemainingUsd: 0.1 });
    expect(sized.status).toBe('below_min');
    expect(sized.minProposal).toBeUndefined();
  });

  it.each([
    { name: 'long stop above entry', patch: { stopPx: 60100 }, leg: 'stop' },
    { name: 'long stop at entry', patch: { stopPx: 60000 }, leg: 'stop' },
    { name: 'long TP below entry', patch: { tpPx: 59900 }, leg: 'tp' },
    { name: 'short stop below entry', patch: { side: 'short', tpPx: 58000 }, leg: 'stop' },
    { name: 'short TP above entry', patch: { side: 'short', stopPx: 61000 }, leg: 'tp' },
    {
      name: 'short stop snapped onto entry',
      patch: { side: 'short', stopPx: 60000.5, tpPx: 58000 },
      leg: 'stop',
    },
  ] as const)('rejects bad geometry: $name', ({ patch, leg }) => {
    const sized = sizePosition({ ...btcLong, snapPrice: truncateTo(0), ...patch });
    expect(sized).toEqual({ ok: false, error: { kind: 'bad_geometry', leg } });
  });

  it.each([
    { field: 'equity', patch: { equity: 0 } },
    { field: 'risk', patch: { risk: { kind: 'usd', value: Number.NaN } } },
    { field: 'entry', patch: { entry: { kind: 'market', refPx: Infinity, maxSlippage: 0.002 } } },
    { field: 'entry', patch: { entry: { kind: 'market', refPx: 60000, maxSlippage: 1 } } },
    { field: 'entry', patch: { entry: { kind: 'limit', px: -1, marketable: false } } },
    { field: 'stopPx', patch: { stopPx: Number.NaN } },
    { field: 'tpPx', patch: { tpPx: -Infinity } },
    { field: 'stopSlippageBuffer', patch: { stopSlippageBuffer: -0.001 } },
    { field: 'maxTradeSz', patch: { maxTradeSz: Number.NaN } },
    { field: 'budgetRemainingUsd', patch: { budgetRemainingUsd: -1 } },
    { field: 'fees', patch: { fees: { taker: Number.NaN, maker: 0 } } },
    { field: 'spec', patch: { spec: { szDecimals: 1.5, maxLeverage: 40, minNotionalUsd: 10 } } },
    { field: 'stopPx', patch: { stopPx: 0.04 } },
  ] as const)('rejects an invalid $field', ({ field, patch }) => {
    expect(sizePosition({ ...btcLong, ...patch })).toEqual({
      ok: false,
      error: { kind: 'invalid_input', field },
    });
  });

  it('rejects fees that make the loss per unit non-positive', () => {
    const sized = sizePosition({
      ...btcLong,
      entry: { kind: 'limit', px: 60000, marketable: false },
      stopPx: 59999,
      stopSlippageBuffer: 0,
      fees: { taker: 0, maker: -0.001 },
    });
    expect(sized).toEqual({ ok: false, error: { kind: 'invalid_input', field: 'fees' } });
  });
});

const validInput = fc
  .record({
    side: fc.constantFrom('long', 'short'),
    market: fc.boolean(),
    marketable: fc.boolean(),
    refPx: fc.double({ min: 0.01, max: 200000, noNaN: true }),
    stopFrac: fc.double({ min: 0.0005, max: 0.5, noNaN: true }),
    tpFrac: fc.double({ min: 0.0005, max: 0.5, noNaN: true }),
    riskUsd: fc.double({ min: 0.01, max: 100000, noNaN: true }),
    equity: fc.double({ min: 1, max: 10_000_000, noNaN: true }),
    budget: fc.option(fc.double({ min: 0, max: 10000, noNaN: true }), { nil: undefined }),
    maxTradeSz: fc.option(fc.double({ min: 0, max: 100000, noNaN: true }), { nil: undefined }),
    szDecimals: fc.integer({ min: 0, max: 5 }),
    maxLeverage: fc.integer({ min: 1, max: 50 }),
    taker: fc.double({ min: 0, max: 0.001, noNaN: true }),
    maker: fc.double({ min: -0.0001, max: 0.0005, noNaN: true }),
  })
  .map((p): SizingInput => {
    const dir = p.side === 'long' ? 1 : -1;
    return {
      side: p.side,
      entry: p.market
        ? { kind: 'market', refPx: p.refPx, maxSlippage: 0.002 }
        : { kind: 'limit', px: p.refPx, marketable: p.marketable },
      stopPx: p.refPx * (1 - dir * p.stopFrac),
      tpPx: p.refPx * (1 + dir * p.tpFrac),
      risk: { kind: 'usd', value: p.riskUsd },
      equity: p.equity,
      budgetRemainingUsd: p.budget,
      stopSlippageBuffer: 0.001,
      maxTradeSz: p.maxTradeSz,
      spec: { szDecimals: p.szDecimals, maxLeverage: p.maxLeverage, minNotionalUsd: 10 },
      fees: { taker: p.taker, maker: p.maker },
      snapPrice: truncateTo(6 - p.szDecimals),
      snapSize: truncateTo(p.szDecimals),
    };
  });

function sizedOrSkip(input: SizingInput): Sizing | undefined {
  const sized = sizePosition(input);
  return sized.ok ? sized.value : undefined;
}

describe('sizePosition invariants', () => {
  it('never risks more than the effective risk after fees', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const sized = sizedOrSkip(input);
        if (!sized) return;
        const effectiveRisk = Math.min(input.risk.value, input.budgetRemainingUsd ?? Infinity);
        expect(sized.riskUsd).toBeLessThanOrEqual(effectiveRisk * (1 + 1e-12));
      }),
    );
  });

  it('never loses more than the effective risk when the stop fills at the buffer edge', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const sized = sizedOrSkip(input);
        if (!sized) return;
        const dir = input.side === 'long' ? 1 : -1;
        const entryFee =
          input.entry.kind === 'limit' && !input.entry.marketable
            ? input.fees.maker
            : input.fees.taker;
        const stopFillPx = sized.stopPx * (1 - dir * input.stopSlippageBuffer);
        const worstLoss =
          sized.size *
          (dir * (sized.entryPx - stopFillPx) +
            sized.entryPx * entryFee +
            stopFillPx * input.fees.taker);
        const effectiveRisk = Math.min(input.risk.value, input.budgetRemainingUsd ?? Infinity);
        expect(worstLoss).toBeLessThanOrEqual(effectiveRisk * (1 + 1e-12));
      }),
    );
  });

  it('never grows the size when the stop moves further away', () => {
    fc.assert(
      fc.property(validInput, fc.double({ min: 0, max: 0.4, noNaN: true }), (input, extra) => {
        const near = sizedOrSkip(input);
        const dir = input.side === 'long' ? 1 : -1;
        const far = sizedOrSkip({ ...input, stopPx: input.stopPx * (1 - dir * extra) });
        if (!near || !far) return;
        expect(far.size).toBeLessThanOrEqual(near.size);
      }),
    );
  });

  it('always returns a whole number of lots', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const sized = sizedOrSkip(input);
        if (!sized) return;
        for (const sz of [sized.size, sized.minProposal?.size ?? 0]) {
          const lots = sz * 10 ** input.spec.szDecimals;
          expect(Math.abs(lots - Math.round(lots))).toBeLessThan(1e-6);
        }
      }),
    );
  });

  it('keeps every leg at or above the minimum notional when ok or proposed', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const sized = sizedOrSkip(input);
        if (!sized) return;
        const cheapestLegPx = Math.min(
          sized.entryPx,
          sized.expectedEntryPx,
          sized.tpPx ?? Infinity,
        );
        if (sized.status === 'ok') expect(sized.size * cheapestLegPx).toBeGreaterThanOrEqual(10);
        if (sized.minProposal) {
          expect(sized.minProposal.size * cheapestLegPx).toBeGreaterThanOrEqual(10);
        }
      }),
    );
  });

  it('never throws and returns only finite numbers, whatever the input', () => {
    const anyNumber = fc.double();
    fc.assert(
      fc.property(
        anyNumber,
        anyNumber,
        anyNumber,
        anyNumber,
        anyNumber,
        fc.constantFrom('long', 'short'),
        (refPx, stopPx, tpPx, risk, equity, side) => {
          const sized = sizePosition({
            ...btcLong,
            side,
            entry: { kind: 'market', refPx, maxSlippage: 0.002 },
            stopPx,
            tpPx,
            risk: { kind: 'usd', value: risk },
            equity,
          });
          if (!sized.ok) return;
          for (const value of Object.values(sized.value)) {
            if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
          }
        },
      ),
    );
  });
});
