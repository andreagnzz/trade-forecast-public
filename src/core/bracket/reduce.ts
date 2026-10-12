import {
  legCloid,
  openSize,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type RejectReason,
  type Step,
} from './bracket';
import { applyChoice } from './choices';
import type { LegName } from './cloid';
import { alert, applyFill, currentLeg, giveUp, isStale, replace, revertTp } from './legs';
import { reconcile } from './reconcile';
import { settle } from './settle';

const MAX_ATTEMPTS = 5;
// A fired exit's fills normally follow within a second. Past this, the bracket stops waiting and
// protects the position it sees: a duplicate stop is cancelled when flat, a missing one is naked.
const FILLS_DUE_MS = 3000;

type OrderEvent = Extract<BracketEvent, { type: 'order' }>;

// The exit stays announced until its fills arrive; the timer starts once, on the first event.
function awaitFills(
  d: Bracket,
  exit: 'sl' | 'tp' | 'close',
  wasFilling: boolean,
): BracketCommand[] {
  d[exit].status = 'filling';
  return wasFilling
    ? []
    : [{ type: 'wait_fills', leg: exit, seq: d[exit].seq, delayMs: FILLS_DUE_MS }];
}

// Every attempt that did not leave a protective leg resting counts: the next one waits longer,
// under the next seq, and the fifth failure asks the user.
function failed(d: Bracket, leg: 'sl' | 'tp'): BracketCommand[] {
  const state = d[leg];
  state.retries += 1;
  if (state.retries >= MAX_ATTEMPTS) {
    giveUp(d, leg);
    return [];
  }
  if (!replace(d, leg, 'waiting')) return [];
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
  if (!leg) {
    return event.status === 'open' && isStale(d, event.cloid)
      ? [{ type: 'cancel', cloid: event.cloid }]
      : [];
  }
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
  }
  // Any status on the new cloid means the modify landed: the order it replaced is gone.
  if (leg === 'tp') d.tp.prev = null;
  if (event.status === 'open') return [];
  const ours = state.status === 'canceling';
  const wasFilling = state.status === 'filling';
  state.status = 'done';
  return onLegDone(d, leg, event, ours, wasFilling);
}

// The order left the book: filled, triggered or cancelled, by us (ours) or not.
function onLegDone(
  d: Bracket,
  leg: LegName,
  event: OrderEvent,
  ours: boolean,
  wasFilling: boolean,
): BracketCommand[] {
  const state = d[leg];
  switch (leg) {
    case 'entry':
      // The IOC response can beat its fill, so the order's own filled size decides.
      state.size = event.filledSz;
      // Filled, even if the fills are not here yet: there is exposure to protect.
      if (event.filledSz > 0) d.cancelling = null;
      else if (d.filledSz === 0) d.cancelling ??= 'no_fill';
      return [];
    case 'sl':
      if (event.status === 'canceled') return ours ? [] : failed(d, 'sl');
      // A stop that fires before any fill means the setup is gone: stop working the entry.
      if (d.filledSz === 0) d.cancelling ??= 'no_fill';
      // HL announces a fired stop before its fills. With size 0 it closes the whole position;
      // its filled update then gives the exact size it closed.
      d.sl.size = event.status === 'filled' ? event.filledSz : d.sl.closedSz + openSize(d);
      return d.sl.closedSz < d.sl.size ? awaitFills(d, 'sl', wasFilling) : [];
    case 'tp':
      if (event.status === 'canceled') return ours ? [] : failed(d, 'tp');
      // Filled on the exchange: what we still see resting is the part whose fills are on the way.
      return event.status === 'filled' && d.tp.size > 0 ? awaitFills(d, 'tp', wasFilling) : [];
    case 'close':
      if (event.status === 'canceled') alert(d, 'close_failed');
      // Its answer can beat its fills: until they come, the size it closed still looks open.
      d.close.size = event.filledSz;
      return d.close.closedSz < d.close.size ? awaitFills(d, 'close', wasFilling) : [];
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
      alert(d, TP_ATTENTION[reason]);
    }
    return [];
  }
  switch (leg) {
    case 'entry':
      d.entry.status = 'done';
      if (d.filledSz === 0) d.cancelling ??= 'no_fill';
      return [];
    case 'sl':
      if (d.entry.status !== 'idle') return failed(d, 'sl');
      giveUp(d, 'sl');
      return [];
    case 'tp':
      if (reason === 'other') return failed(d, 'tp');
      replace(d, 'tp');
      alert(d, TP_ATTENTION[reason]);
      return [];
    case 'close':
      d.close.status = 'done';
      alert(d, 'close_failed');
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
      alert(d, 'entry_unknown');
      return [];
    case 'close':
      d.close.status = 'done';
      alert(d, 'close_failed');
      return [];
    case 'tp':
      if (d.tp.prev) {
        revertTp(d);
        return [];
      }
  }
  // Counted as a failure so an order that keeps not reaching the exchange backs off and stops.
  // If the lost request lands after all, its old seq shows up as stale and gets cancelled.
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
    case 'fills_due': {
      const exit = d[event.leg];
      if (exit.status === 'filling' && exit.seq === event.seq) exit.status = 'done';
      return [];
    }
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
