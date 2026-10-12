import { makeCloid, type Cloid, type CloidPrefix, type LegName } from './cloid';

type Side = 'long' | 'short';
type OrderType = 'ioc' | 'gtc' | 'alo' | 'stop_market';

// size 0 on a stop_market means the whole position, whatever it grows to.
export interface OrderSpec {
  isBuy: boolean;
  px: number;
  size: number;
  reduceOnly: boolean;
  type: OrderType;
}

export interface BracketPlan {
  id: string;
  prefix: CloidPrefix;
  coin: string;
  side: Side;
  entry: { type: 'ioc' | 'gtc' | 'alo'; px: number };
  size: number;
  szDecimals: number;
  minNotionalUsd: number;
  stopPx: number;
  tpPx: number | null;
  riskUsd: number;
}

// filling: the order left the book filled or triggered, and its fills are still on the way.
type LegStatus = 'idle' | 'sending' | 'live' | 'canceling' | 'waiting' | 'filling' | 'done';

// seq names the order the leg tracks; maxSeq is the highest it ever sent, since a refused
// take-profit resize goes back to tracking an older one.
interface LegState {
  seq: number;
  maxSeq: number;
  status: LegStatus;
  size: number;
  retries: number;
}

export type Attention =
  'entry_unknown' | 'sl_failed' | 'tp_would_cross' | 'tp_below_min' | 'tp_failed' | 'close_failed';

type CancelReason = 'no_fill' | 'sl_rejected' | 'dismissed';

export interface Bracket {
  plan: BracketPlan;
  entry: LegState;
  // Once the stop fires, size is what it closes and closedSz what its fills have closed so far.
  sl: LegState & { closedSz: number };
  // prev is the order a modify in flight replaces: it still rests until the modify lands.
  tp: LegState & {
    px: number | null;
    sentPx: number | null;
    prev: { seq: number; size: number; px: number | null } | null;
  };
  close: LegState;
  filledSz: number;
  exitedSz: number;
  tids: number[];
  pnlUsd: number;
  cancelling: CancelReason | null;
  attention: Attention | null;
  outcome: { kind: 'closed' } | { kind: 'cancelled'; reason: CancelReason } | null;
}

// Every fill on the bracket's coin since it was sent. One position per coin, so fills on the
// entry side grow it and fills on the other side shrink it.
export interface BracketFill {
  tid: number;
  cloid: string | null;
  isBuy: boolean;
  size: number;
  closedPnl: number;
  fee: number;
  time: number;
}

// order_gone: a modify found its order already filled or cancelled.
export type RejectReason = 'post_only_would_cross' | 'below_min_notional' | 'order_gone' | 'other';

// The outcome of a modify (open, rejected, uncertain, unknown) is reported on its `next` cloid.
export type BracketEvent =
  | {
      type: 'order';
      cloid: string;
      status: 'open' | 'filled' | 'canceled' | 'triggered';
      filledSz: number;
    }
  | { type: 'rejected'; cloid: string; reason: RejectReason }
  | { type: 'uncertain' | 'unknown'; cloid: string }
  | ({ type: 'fill' } & BracketFill)
  | { type: 'retry_due'; leg: 'sl' | 'tp' }
  | { type: 'snapshot'; open: { cloid: string; size: number }[]; fills: BracketFill[] }
  | { type: 'cancel_entry' | 'sl_only' | 'dismiss' }
  | { type: 'close' | 'tp_at'; px: number };

export type BracketCommand =
  | { type: 'place'; cloid: Cloid; order: OrderSpec }
  | { type: 'modify'; cloid: Cloid; next: Cloid; order: OrderSpec }
  | { type: 'cancel'; cloid: Cloid }
  | { type: 'query'; cloid: Cloid }
  | { type: 'retry'; leg: 'sl' | 'tp'; delayMs: number };

export interface Step {
  state: Bracket;
  commands: BracketCommand[];
}

export type Phase =
  | 'submitting'
  | 'entry_working'
  | 'partial'
  | 'protected'
  | 'closing'
  | 'closed'
  | 'cancelled'
  | 'attention';

const leg = (): LegState => ({ seq: 0, maxSeq: 0, status: 'idle', size: 0, retries: 0 });

export const legCloid = (b: Bracket, name: LegName) =>
  makeCloid(b.plan.prefix, b.plan.id, name, b[name].seq);

export const roundSize = (b: Bracket, size: number) => Number(size.toFixed(b.plan.szDecimals));

export const openSize = (b: Bracket) => roundSize(b, b.filledSz - b.exitedSz);

// The entry's final filled size arrives with its last order event; its fills may lag behind.
export const entryFinished = (b: Bracket) =>
  b.entry.status === 'done' && b.filledSz >= b.entry.size;

export const LEGS = ['entry', 'sl', 'tp', 'close'] as const;

export const exitIsBuy = (b: Bracket) => b.plan.side === 'short';

// Fills happened and every one of them has been closed out.
export const isFlat = (b: Bracket) => b.filledSz > 0 && openSize(b) <= 0;

// The take-profit is parked until the trader picks one of the offered choices.
export const isTpAttention = (attention: Attention | null) =>
  attention === 'tp_would_cross' || attention === 'tp_below_min' || attention === 'tp_failed';

export function stopOrder(b: Bracket): OrderSpec {
  return {
    isBuy: exitIsBuy(b),
    px: b.plan.stopPx,
    size: 0,
    reduceOnly: true,
    type: 'stop_market',
  };
}

export function entryOrder(b: Bracket): OrderSpec {
  const { entry, size } = b.plan;
  return { isBuy: !exitIsBuy(b), px: entry.px, size, reduceOnly: false, type: entry.type };
}

export function exitOrder(b: Bracket, px: number, type: 'alo' | 'ioc'): OrderSpec {
  return { isBuy: exitIsBuy(b), px, size: openSize(b), reduceOnly: true, type };
}

// The position stop goes first: every later fill is covered on the exchange, tab open or not.
export function openBracket(plan: BracketPlan): Step {
  const state: Bracket = {
    plan,
    entry: leg(),
    sl: { ...leg(), status: 'sending', closedSz: 0 },
    tp: { ...leg(), px: plan.tpPx, sentPx: null, prev: null },
    close: leg(),
    filledSz: 0,
    exitedSz: 0,
    tids: [],
    pnlUsd: 0,
    cancelling: null,
    attention: null,
    outcome: null,
  };
  return {
    state,
    commands: [{ type: 'place', cloid: legCloid(state, 'sl'), order: stopOrder(state) }],
  };
}

export function phase(b: Bracket): Phase {
  if (b.outcome) return b.outcome.kind;
  // The wind-down waits on the trader's dismiss.
  if (b.attention === 'entry_unknown') return 'attention';
  if (b.cancelling || isFlat(b)) return 'closing';
  if (b.attention) return 'attention';
  if (b.filledSz === 0) {
    return b.entry.status === 'idle' || b.entry.status === 'sending'
      ? 'submitting'
      : 'entry_working';
  }
  const tpMatches = b.tp.px === null || (b.tp.status === 'live' && b.tp.size === openSize(b));
  return entryFinished(b) && tpMatches && b.sl.status === 'live' ? 'protected' : 'partial';
}

// HL accepts a stop the mark has already crossed and fires it at the next mark update, so
// such a bracket would stop out at once.
export const stopCrossed = (plan: BracketPlan, markPx: number) =>
  plan.side === 'long' ? markPx <= plan.stopPx : markPx >= plan.stopPx;

// A fired stop is closing the position: that is not a gap.
export const isUnprotected = (b: Bracket) =>
  openSize(b) > 0 && b.sl.status !== 'live' && b.sl.status !== 'filling';

export const rMultiple = (b: Bracket) => b.pnlUsd / b.plan.riskUsd;
