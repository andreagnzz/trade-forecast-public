type Side = 'long' | 'short';

interface InstrumentSpec {
  szDecimals: number;
  maxLeverage: number;
  minNotionalUsd: number;
}

interface FeeRates {
  taker: number;
  maker: number;
}

export interface SizingInput {
  side: Side;
  entry:
    | { kind: 'market'; refPx: number; maxSlippage: number }
    | { kind: 'limit'; px: number; marketable: boolean };
  stopPx: number;
  tpPx?: number;
  risk: { kind: 'usd'; value: number } | { kind: 'pct_equity'; value: number };
  equity: number;
  budgetRemainingUsd?: number;
  stopSlippageBuffer: number;
  maxTradeSz?: number;
  spec: InstrumentSpec;
  fees: FeeRates;
  snapPrice: (px: number) => number;
  snapSize: (sz: number) => number;
}

type SizingStatus = 'ok' | 'below_min' | 'budget_exhausted';
type Binding = 'risk' | 'budget' | 'max_trade_sz' | 'leverage' | 'min_notional';

export interface Sizing {
  status: SizingStatus;
  binding: Binding;
  entryPx: number;
  expectedEntryPx: number;
  stopPx: number;
  tpPx?: number;
  size: number;
  notional: number;
  leverage: number;
  riskUsd: number;
  riskPct: number;
  priceRiskUsd: number;
  feesAtStopUsd: number;
  expectedRiskUsd: number;
  rewardUsd?: number;
  rr?: number;
  minProposal?: { size: number; riskUsd: number };
  warnings: 'tp_inside_expected_entry'[];
}

type SizingField = keyof Omit<SizingInput, 'side' | 'snapPrice' | 'snapSize'>;

type SizingError =
  { kind: 'invalid_input'; field: SizingField } | { kind: 'bad_geometry'; leg: 'stop' | 'tp' };

export type SizingResult = { ok: true; value: Sizing } | { ok: false; error: SizingError };

interface Prices {
  entryPx: number;
  expectedEntryPx: number;
  stopPx: number;
  tpPx?: number;
}

const isPositive = (x: number) => Number.isFinite(x) && x > 0;
const isNonNegative = (x: number) => Number.isFinite(x) && x >= 0;

function invalidField(input: SizingInput): SizingField | undefined {
  const { entry, spec } = input;
  const entryValid =
    entry.kind === 'market'
      ? isPositive(entry.refPx) && isNonNegative(entry.maxSlippage) && entry.maxSlippage < 1
      : isPositive(entry.px);
  if (!isPositive(input.equity)) return 'equity';
  if (!isPositive(input.risk.value)) return 'risk';
  if (!entryValid) return 'entry';
  if (!isPositive(input.stopPx)) return 'stopPx';
  if (input.tpPx !== undefined && !isPositive(input.tpPx)) return 'tpPx';
  if (!isNonNegative(input.stopSlippageBuffer)) return 'stopSlippageBuffer';
  if (input.maxTradeSz !== undefined && !isNonNegative(input.maxTradeSz)) return 'maxTradeSz';
  if (input.budgetRemainingUsd !== undefined && !isNonNegative(input.budgetRemainingUsd)) {
    return 'budgetRemainingUsd';
  }
  if (!isNonNegative(input.fees.taker) || !Number.isFinite(input.fees.maker)) return 'fees';
  const specValid =
    Number.isInteger(spec.szDecimals) &&
    spec.szDecimals >= 0 &&
    isPositive(spec.maxLeverage) &&
    isNonNegative(spec.minNotionalUsd);
  return specValid ? undefined : 'spec';
}

// HL formatters truncate, so everything downstream must use these snapped prices.
// A market entry is sized at the IOC limit price, the worst fill it can get.
function snapPrices(
  input: SizingInput,
  dir: number,
): { ok: true; prices: Prices } | { ok: false; error: SizingError } {
  const { entry, snapPrice } = input;
  const invalid = (field: SizingField) =>
    ({ ok: false, error: { kind: 'invalid_input', field } }) as const;
  const badGeometry = (leg: 'stop' | 'tp') =>
    ({ ok: false, error: { kind: 'bad_geometry', leg } }) as const;
  const expectedEntryPx = snapPrice(entry.kind === 'market' ? entry.refPx : entry.px);
  const entryPx =
    entry.kind === 'market'
      ? snapPrice(entry.refPx * (1 + dir * entry.maxSlippage))
      : expectedEntryPx;
  const stopPx = snapPrice(input.stopPx);
  const tpPx = input.tpPx === undefined ? undefined : snapPrice(input.tpPx);
  if (!isPositive(expectedEntryPx) || !isPositive(entryPx)) return invalid('entry');
  if (!isPositive(stopPx)) return invalid('stopPx');
  if (tpPx !== undefined && !isPositive(tpPx)) return invalid('tpPx');
  if (dir * (expectedEntryPx - stopPx) <= 0) return badGeometry('stop');
  if (tpPx !== undefined && dir * (tpPx - expectedEntryPx) <= 0) return badGeometry('tp');
  return { ok: true, prices: { entryPx, expectedEntryPx, stopPx, tpPx } };
}

function minSizeForNotional(minNotionalUsd: number, legPx: number, szDecimals: number): number {
  const scale = 10 ** szDecimals;
  const lots = Math.ceil((minNotionalUsd / legPx) * scale);
  // The float product can land a hair under the minimum; one more lot settles it.
  return (lots / scale) * legPx < minNotionalUsd ? (lots + 1) / scale : lots / scale;
}

type ConstrainedSize = Pick<Sizing, 'size' | 'status' | 'binding' | 'minProposal'>;

function constrainSize(input: SizingInput, prices: Prices, lossPerUnit: number): ConstrainedSize {
  const { spec, equity, snapSize } = input;
  const requestedUsd =
    input.risk.kind === 'usd' ? input.risk.value : (equity * input.risk.value) / 100;
  const budgetUsd = input.budgetRemainingUsd ?? Infinity;
  const effectiveUsd = Math.min(requestedUsd, budgetUsd);
  const binding: Binding = effectiveUsd < requestedUsd ? 'budget' : 'risk';
  if (effectiveUsd === 0) return { size: 0, status: 'budget_exhausted', binding };

  const maxSize = Math.min(
    input.maxTradeSz ?? Infinity,
    (equity * spec.maxLeverage) / prices.entryPx,
  );
  const riskSize = snapSize(effectiveUsd / lossPerUnit);
  const capped = riskSize > maxSize;
  const size = capped ? snapSize(maxSize) : riskSize;

  // The position SL is placed with no size, so only entry and TP are sized legs. A long can
  // fill at the expected price, below the worst-case IOC price, so both entry prices count.
  const cheapestLegPx = Math.min(prices.entryPx, prices.expectedEntryPx, prices.tpPx ?? Infinity);
  if (size * cheapestLegPx >= spec.minNotionalUsd) {
    const capBinding = maxSize === input.maxTradeSz ? 'max_trade_sz' : 'leverage';
    return { size, status: 'ok', binding: capped ? capBinding : binding };
  }
  const minSize = minSizeForNotional(spec.minNotionalUsd, cheapestLegPx, spec.szDecimals);
  return {
    size,
    status: 'below_min',
    binding: 'min_notional',
    minProposal:
      minSize <= maxSize && minSize * lossPerUnit <= budgetUsd
        ? { size: minSize, riskUsd: minSize * lossPerUnit }
        : undefined,
  };
}

function reward(
  size: number,
  rewardPerUnit: number | undefined,
  lossPerUnit: number,
): Pick<Sizing, 'rewardUsd' | 'rr' | 'warnings'> {
  if (rewardPerUnit === undefined) return { warnings: [] };
  return {
    rewardUsd: size * rewardPerUnit,
    rr: rewardPerUnit / lossPerUnit,
    warnings: rewardPerUnit <= 0 ? ['tp_inside_expected_entry'] : [],
  };
}

export function sizePosition(input: SizingInput): SizingResult {
  const field = invalidField(input);
  if (field) return { ok: false, error: { kind: 'invalid_input', field } };
  const dir = input.side === 'long' ? 1 : -1;
  const snapped = snapPrices(input, dir);
  if (!snapped.ok) return snapped;

  const { prices } = snapped;
  const { entryPx, expectedEntryPx, stopPx, tpPx } = prices;
  const { fees, equity, stopSlippageBuffer: buffer } = input;
  const entryFee =
    input.entry.kind === 'limit' && !input.entry.marketable ? fees.maker : fees.taker;
  // The SL is a market trigger on the mark: charge the buffer, and the taker fee at the
  // buffered fill price, which is above the stop on a short.
  const stopCost = stopPx * (buffer + fees.taker * (1 + buffer));
  const lossAt = (px: number) => dir * (px - stopPx) + px * entryFee + stopCost;
  const lossPerUnit = lossAt(entryPx);
  if (!(lossPerUnit > 0)) return { ok: false, error: { kind: 'invalid_input', field: 'fees' } };

  const constrained = constrainSize(input, prices, lossPerUnit);
  const { size } = constrained;
  const rewardPerUnit =
    tpPx === undefined
      ? undefined
      : dir * (tpPx - entryPx) - entryPx * entryFee - tpPx * fees.maker;
  const notional = size * entryPx;
  const riskUsd = size * lossPerUnit;
  const priceRiskUsd = size * dir * (entryPx - stopPx);
  return {
    ok: true,
    value: {
      ...constrained,
      ...prices,
      notional,
      leverage: notional / equity,
      riskUsd,
      riskPct: (riskUsd / equity) * 100,
      priceRiskUsd,
      feesAtStopUsd: riskUsd - priceRiskUsd,
      expectedRiskUsd: size * lossAt(expectedEntryPx),
      ...reward(size, rewardPerUnit, lossPerUnit),
    },
  };
}
