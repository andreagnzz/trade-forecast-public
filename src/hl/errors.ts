// Prefixes of the official error strings ("Error responses" page); HL appends " asset=<id>".
const PREFIXES = [
  ['BadAloPx', 'Post only order would have immediately matched'],
  ['ReduceOnly', 'Reduce only order would increase position'],
  ['MinTradeNtl', 'Order must have minimum value of'],
  ['PerpMargin', 'Insufficient margin to place order'],
  ['PerpMaxPosition', 'Order would cause position to exceed margin tier limit'],
  ['Tick', 'Price must be divisible by tick size'],
  ['IocCancel', 'Order could not immediately match against any resting orders'],
  ['BadTriggerPx', 'Invalid TP/SL price'],
  ['Oracle', 'Order price too far from oracle'],
  ['MarketOrderNoLiquidity', 'No liquidity available for market order'],
  ['OpenInterestIncrease', 'Order would increase open interest too quickly'],
  ['MissingOrder', 'Order was never placed, already canceled, or filled'],
  // Not in the official table; observed on testnet for a modify of a finished order.
  ['ModifyGone', 'Cannot modify canceled or filled order'],
] as const;

type HlErrorCode = (typeof PREFIXES)[number][0] | 'Unknown';

export interface HlError {
  code: HlErrorCode;
  message: string;
}

const ERROR_TEXT: Record<HlErrorCode, string> = {
  BadAloPx: 'rejected: post-only would cross',
  ReduceOnly: 'rejected: reduce-only would increase position',
  MinTradeNtl: 'rejected: below $10 minimum',
  PerpMargin: 'rejected: insufficient margin',
  PerpMaxPosition: 'rejected: above margin tier limit',
  Tick: 'rejected: price off tick',
  IocCancel: 'not filled: no liquidity at limit',
  BadTriggerPx: 'rejected: invalid trigger price',
  Oracle: 'rejected: price too far from oracle',
  MarketOrderNoLiquidity: 'rejected: no liquidity',
  OpenInterestIncrease: 'rejected: open interest rising too fast',
  MissingOrder: 'order already gone',
  ModifyGone: 'order already gone',
  Unknown: 'rejected',
};

// An unrecognised rejection keeps HL's own words: they are the only clue the trader gets.
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const errorText = (error: HlError) =>
  error.code === 'Unknown' ? `rejected: ${error.message}` : ERROR_TEXT[error.code];

export function parseHlError(message: string): HlError {
  const code = PREFIXES.find(([, prefix]) => message.startsWith(prefix))?.[0] ?? 'Unknown';
  return { code, message };
}

// orderUpdates and orderStatus name a rejection after its code: "badAloPxRejected".
export function errorFromStatus(status: string): HlError {
  const code = PREFIXES.find(
    ([key]) => status === `${key.charAt(0).toLowerCase()}${key.slice(1)}Rejected`,
  )?.[0];
  return { code: code ?? 'Unknown', message: status };
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

// An ApiRequestError carries either {status:"err", response:"<text>"} or an order response
// whose statuses hold {error:"<text>"}.
export function rejectionText(response: unknown): string {
  const body = field(response, 'response');
  if (typeof body === 'string') return body;
  const statuses = field(field(body, 'data'), 'statuses');
  if (!Array.isArray(statuses)) return '';
  const text = statuses
    .map((status: unknown) => field(status, 'error'))
    .find((e) => typeof e === 'string');
  return typeof text === 'string' ? text : '';
}
