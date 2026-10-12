import {
  LEGS,
  entryFinished,
  entryOrder,
  exitOrder,
  isFlat,
  isTpAttention,
  legCloid,
  openSize,
  stopOrder,
  type Bracket,
  type BracketCommand,
} from './bracket';
import type { LegName } from './cloid';
import { replace } from './legs';

const EXITS = ['sl', 'tp', 'close'] as const;

function cancelLive(d: Bracket, legs: readonly LegName[]): BracketCommand[] {
  const commands: BracketCommand[] = [];
  for (const leg of legs) {
    const state = d[leg];
    if (state.status === 'live') {
      state.status = 'canceling';
      commands.push({ type: 'cancel', cloid: legCloid(d, leg) });
    } else if (state.status === 'idle' || state.status === 'waiting') {
      state.status = 'done';
    }
  }
  return commands;
}

const inFlight = (d: Bracket) =>
  LEGS.some((leg) => d[leg].status === 'sending' || d[leg].status === 'canceling');

// Unfilled bracket: nothing to protect, every resting leg can go at once. It only ends once
// any fill the entry announced has arrived, since that fill would reopen protection.
function windDown(d: Bracket, reason: NonNullable<Bracket['cancelling']>): BracketCommand[] {
  const commands = cancelLive(d, LEGS);
  const settled = d.entry.status === 'idle' || entryFinished(d);
  if (!inFlight(d) && settled) d.outcome = { kind: 'cancelled', reason };
  return commands;
}

// Flat after fills: stop the entry first and wait for its final size. A fill that lands in
// between reopens the position, and the stop is still there to cover it.
function flatten(d: Bracket): BracketCommand[] {
  if (d.entry.status === 'live') return cancelLive(d, ['entry']);
  if (!entryFinished(d)) return [];
  const commands = cancelLive(d, EXITS);
  if (!inFlight(d)) d.outcome = { kind: 'closed' };
  return commands;
}

function protect(d: Bracket): BracketCommand[] {
  // Fills the entry announced but that have not arrived yet are exposure too.
  const exposed = openSize(d) > 0 || d.entry.status === 'live' || d.entry.size > d.filledSz;
  if (d.sl.status === 'done' && exposed && d.attention !== 'sl_failed') replace(d, 'sl');
  const commands: BracketCommand[] = [];
  if (d.sl.status === 'idle') {
    d.sl.status = 'sending';
    commands.push({ type: 'place', cloid: legCloid(d, 'sl'), order: stopOrder(d) });
  } else if (d.sl.status === 'live' && d.entry.status === 'idle') {
    d.entry.status = 'sending';
    commands.push({ type: 'place', cloid: legCloid(d, 'entry'), order: entryOrder(d) });
  }
  // A working entry never rests without a live stop behind it.
  if (d.entry.status === 'live' && d.sl.status !== 'live')
    commands.push(...cancelLive(d, ['entry']));
  return commands;
}

function takeProfit(d: Bracket): BracketCommand[] {
  const { tp } = d;
  const size = openSize(d);
  const blocked = isTpAttention(d.attention) || d.close.status === 'sending';
  if (tp.px === null || blocked || size <= 0) return [];
  // An entry often fills in pieces: HL refuses a take-profit under the minimum unless it
  // closes the whole position, so wait for more fills, or for the entry to finish.
  if (size * tp.px < d.plan.minNotionalUsd && !entryFinished(d)) return [];
  const order = exitOrder(d, tp.px, 'alo');
  if (tp.status === 'done') replace(d, 'tp');
  if (tp.status === 'idle') {
    Object.assign(tp, { status: 'sending', size, sentPx: tp.px });
    return [{ type: 'place', cloid: legCloid(d, 'tp'), order }];
  }
  const resize = tp.size !== size || tp.sentPx !== tp.px;
  if (tp.status !== 'live' || tp.prev || !resize) return [];
  const cloid = legCloid(d, 'tp');
  Object.assign(tp, {
    prev: { seq: tp.seq, size: tp.size, px: tp.sentPx },
    seq: tp.seq + 1,
    status: 'sending',
    size,
    sentPx: tp.px,
  });
  return [{ type: 'modify', cloid, next: legCloid(d, 'tp'), order }];
}

// Drives the exchange toward the state the bracket needs. Live events and reconstruction both
// end here, so a reload resumes with the same rules as a running tab.
export function settle(d: Bracket): BracketCommand[] {
  if (d.cancelling) return windDown(d, d.cancelling);
  if (isFlat(d)) return flatten(d);
  return [...protect(d), ...takeProfit(d)];
}
