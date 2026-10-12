import type { BracketEvent, BracketFill, RejectReason } from '../core/bracket/bracket';
import type { AccountFill, OrderUpdate } from '../hl/account';
import { errorText, type HlError } from '../hl/errors';
import type { QueryResult } from '../hl/exchange';
import { statusView, type StatusView } from '../hl/orders';
import type { SendResult } from './orderService';

// What the reducer should hear, and the line the trader should read, for one exchange answer.
export interface Translated {
  event: BracketEvent | null;
  error: string | null;
}

function rejectReason(error: HlError): RejectReason {
  if (error.code === 'BadAloPx') return 'post_only_would_cross';
  if (error.code === 'ModifyGone') return 'order_gone';
  return error.code === 'MinTradeNtl' ? 'below_min_notional' : 'other';
}

// A resize that finds its order already gone is routine, not something to show the trader.
const rejection = (cloid: string, error: HlError): Translated => ({
  event: { type: 'rejected', cloid, reason: rejectReason(error) },
  error: error.code === 'ModifyGone' ? null : errorText(error),
});

export function sendEvent(cloid: string, result: SendResult): Translated {
  switch (result.status) {
    case 'resting':
      return { event: { type: 'order', cloid, status: 'open', filledSz: 0 }, error: null };
    case 'filled':
      return {
        event: { type: 'order', cloid, status: 'filled', filledSz: result.filledSz },
        error: null,
      };
    case 'canceled':
      return { event: null, error: null };
    case 'rejected':
      return rejection(cloid, result.error);
    case 'uncertain':
      return { event: { type: 'uncertain', cloid }, error: null };
    case 'blocked':
      return {
        event: { type: 'rejected', cloid, reason: 'other' },
        error: `blocked: ${result.reasons.join(', ')}`,
      };
    // Refused before signing: a sure rejection, never an order of unknown fate.
    case 'unavailable':
      return {
        event: { type: 'rejected', cloid, reason: 'other' },
        error: 'not sent: day stats unavailable',
      };
  }
}

function orderEvent(cloid: string, view: StatusView): Translated {
  if (view.state === 'rejected') return rejection(cloid, view.error);
  return {
    event: { type: 'order', cloid, status: view.state, filledSz: view.filledSz },
    error: null,
  };
}

// null means the status itself could not be read: ask again later.
export function queryEvent(cloid: string, result: QueryResult): Translated | null {
  switch (result.kind) {
    case 'uncertain':
      return null;
    case 'unknown':
      return { event: { type: 'unknown', cloid }, error: null };
    case 'order':
      return orderEvent(cloid, result);
  }
}

export const updateEvent = (update: OrderUpdate & { cloid: string }, szDecimals: number) =>
  orderEvent(update.cloid, statusView(update, update.status, szDecimals));

export const toBracketFill = (f: AccountFill): BracketFill => ({
  tid: f.tid,
  cloid: f.cloid,
  isBuy: f.side === 'buy',
  size: f.sz,
  closedPnl: f.closedPnl,
  fee: f.fee,
  time: f.time,
});
