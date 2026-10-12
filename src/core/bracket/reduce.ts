import {
  legCloid,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type RejectReason,
  type Step,
} from './bracket';
import { applyChoice } from './choices';
import { applyFill, currentLeg, replace, revertTp } from './legs';
import { reconcile } from './reconcile';
import { settle } from './settle';

const MAX_ATTEMPTS = 5;

type OrderEvent = Extract<BracketEvent, { type: 'order' }>;

function failed(d: Bracket, leg: 'sl' | 'tp'): BracketCommand[] {
  const state = d[leg];
  state.retries += 1;
  if (state.retries >= MAX_ATTEMPTS) {
    state.status = 'done';
    d.attention = leg === 'sl' ? 'sl_failed' : 'tp_failed';
    return [];
  }
  state.status = 'waiting';
  return [{ type: 'retry', leg, delayMs: 250 * 2 ** (state.retries - 1) }];
}

const TP_ATTENTION = {
  post_only_would_cross: 'tp_would_cross',
  below_min_notional: 'tp_below_min',
  order_gone: 'tp_failed',
  other: 'tp_failed',
} as const satisfies Record<RejectReason, Bracket['attention']>;

function onOrder(d: Bracket, event: OrderEvent): BracketCommand[] {
  const leg = currentLeg(d, event.cloid);
  if (!leg) return [];
  const state = d[leg];
  if (event.status === 'open') {
    // Still resting after we asked to cancel it: that cancel never landed.
    if (state.status === 'canceling') return [{ type: 'cancel', cloid: legCloid(d, leg) }];
    if (state.status === 'sending') state.status = 'live';
    // An entry the exchange had no record of has landed after all: track it again.
    if (leg === 'entry' && state.status === 'done') {
      state.status = 'live';
      if (d.attention === 'entry_unknown') d.attention = null;
    }
    state.retries = 0;
  }
  // Any status on the new cloid means the modify landed: the order it replaced is gone.
  if (leg === 'tp') d.tp.prev = null;
  if (event.status === 'open') return [];
  const ours = state.status === 'canceling';
  state.status = 'done';
  switch (leg) {
    case 'entry':
      // The IOC response can beat its fill, so the order's own filled size decides.
      state.size = event.filledSz;
      // Filled, even if the fills are not here yet: there is exposure to protect.
      if (event.filledSz > 0) d.cancelling = null;
      else if (d.filledSz === 0) d.cancelling ??= 'no_fill';
      return [];
    case 'sl':
      // A fired stop leaves the book on its own; its fill follows.
      if (event.status === 'triggered') state.status = 'canceling';
      // A stop that fires before any fill means the setup is gone: stop working the entry.
      if (event.status !== 'canceled' && d.filledSz === 0) d.cancelling ??= 'no_fill';
      if (event.status === 'canceled' && !ours) replace(d, 'sl');
      return [];
    case 'tp':
      if (event.status === 'canceled' && !ours) replace(d, 'tp');
      return [];
    case 'close':
      if (event.status === 'canceled') d.attention = 'close_failed';
      return [];
  }
}

function onRejected(d: Bracket, cloid: string, reason: RejectReason): BracketCommand[] {
  const leg = currentLeg(d, cloid);
  if (!leg) return [];
  if (leg === 'tp' && d.tp.prev) {
    // HL pulled or filled the take-profit before the resize landed (a close shrank the
    // position): nothing rests, and settle places a fresh one if a position is still open.
    // Any other refusal leaves the previous take-profit resting.
    if (reason === 'order_gone') Object.assign(d.tp, { prev: null, status: 'done' });
    else {
      revertTp(d);
      d.attention = TP_ATTENTION[reason];
    }
    return [];
  }
  if (leg === 'close') {
    d.close.status = 'done';
    d.attention = 'close_failed';
    return [];
  }
  replace(d, leg, 'done');
  switch (leg) {
    case 'entry':
      if (d.filledSz === 0) d.cancelling ??= 'no_fill';
      return [];
    case 'sl':
      if (d.entry.status !== 'idle') return failed(d, 'sl');
      d.cancelling ??= 'sl_rejected';
      return [];
    case 'tp':
      if (reason === 'other') return failed(d, 'tp');
      d.tp.status = 'idle';
      d.attention = TP_ATTENTION[reason];
      return [];
  }
}

// orderStatus answered "unknownOid": the order never reached the book.
function onUnknown(d: Bracket, cloid: string): BracketCommand[] {
  const leg = currentLeg(d, cloid);
  if (!leg) return [];
  const state = d[leg];
  if (state.status === 'canceling') state.status = 'done';
  if (state.status !== 'sending') return [];
  switch (leg) {
    case 'entry':
      d.entry.status = 'done';
      d.attention = 'entry_unknown';
      return [];
    case 'close':
      d.close.status = 'done';
      d.attention = 'close_failed';
      return [];
    case 'tp':
      if (d.tp.prev) {
        revertTp(d);
        return [];
      }
  }
  // Counted as a failure so an order that keeps not reaching the exchange backs off and stops.
  // If the lost request lands after all, its old seq shows up as stale and gets cancelled.
  state.seq += 1;
  return failed(d, leg);
}

function apply(d: Bracket, event: BracketEvent): BracketCommand[] {
  switch (event.type) {
    case 'order':
      return onOrder(d, event);
    case 'rejected':
      return onRejected(d, event.cloid, event.reason);
    case 'uncertain': {
      const leg = currentLeg(d, event.cloid);
      return leg ? [{ type: 'query', cloid: legCloid(d, leg) }] : [];
    }
    case 'unknown':
      return onUnknown(d, event.cloid);
    case 'fill':
      applyFill(d, event);
      return [];
    case 'retry_due':
      if (d[event.leg].status === 'waiting') d[event.leg].status = 'idle';
      return [];
    case 'snapshot':
      return reconcile(d, event);
    default:
      return applyChoice(d, event);
  }
}

export function reduceBracket(b: Bracket, event: BracketEvent): Step {
  if (b.outcome) return { state: b, commands: [] };
  const draft = structuredClone(b);
  const commands = apply(draft, event);
  commands.push(...settle(draft));
  return { state: draft, commands };
}
