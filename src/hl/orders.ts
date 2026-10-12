import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import type { OrderSpec } from '../core/bracket/bracket';
import type { Cloid } from '../core/bracket/cloid';
import { errorFromStatus, parseHlError, type HlError } from './errors';

export type OrderResult =
  | { status: 'resting' | 'canceled' | 'uncertain' }
  | { status: 'filled'; filledSz: number }
  | { status: 'rejected'; error: HlError };

type OrderState = 'open' | 'filled' | 'canceled' | 'triggered' | 'rejected';

type PlaceStatus =
  | 'waitingForFill'
  | 'waitingForTrigger'
  | { resting: unknown }
  | { filled: { totalSz: string } }
  | { error: string };

const TIF = { ioc: 'Ioc', gtc: 'Gtc', alo: 'Alo' } as const;

// A position stop has no size: s:"0" with positionTpsl closes the whole position, however
// large it has grown when it triggers.
export function toWireOrder(asset: number, szDecimals: number, cloid: Cloid, spec: OrderSpec) {
  const p = formatPrice(spec.px, szDecimals, 'perp');
  return {
    a: asset,
    b: spec.isBuy,
    p,
    s: spec.size === 0 ? '0' : formatSize(spec.size, szDecimals),
    r: spec.reduceOnly,
    t:
      spec.type === 'stop_market'
        ? { trigger: { isMarket: true, triggerPx: p, tpsl: 'sl' as const } }
        : { limit: { tif: TIF[spec.type] } },
    c: cloid,
  };
}

export const groupingFor = (spec: OrderSpec) =>
  spec.type === 'stop_market' && spec.size === 0 ? 'positionTpsl' : 'na';

// "filled" only says something filled: a GTC can fill in part and keep resting.
export function placeResult(status: PlaceStatus | undefined, spec: OrderSpec): OrderResult {
  if (status === undefined) return { status: 'uncertain' };
  if (typeof status === 'string' || 'resting' in status) return { status: 'resting' };
  if ('error' in status) return { status: 'rejected', error: parseHlError(status.error) };
  const filledSz = Number(status.filled.totalSz);
  return spec.type === 'ioc' || filledSz >= spec.size
    ? { status: 'filled', filledSz }
    : { status: 'resting' };
}

function orderState(status: string): OrderState {
  if (status === 'open' || status === 'filled' || status === 'triggered') return status;
  return status.endsWith('Rejected') || status === 'rejected' ? 'rejected' : 'canceled';
}

export type StatusView =
  | { state: 'rejected'; error: HlError }
  | { state: Exclude<OrderState, 'rejected'>; filledSz: number };

// One reading of an order's status for orderStatus and orderUpdates alike. A finished order
// keeps origSz and its unfilled sz, so origSz - sz is what actually filled.
export function statusView(
  order: { origSz: string; sz: string },
  status: string,
  szDecimals: number,
): StatusView {
  const state = orderState(status);
  if (state === 'rejected') return { state, error: errorFromStatus(status) };
  return {
    state,
    filledSz: Number((Number(order.origSz) - Number(order.sz)).toFixed(szDecimals)),
  };
}
