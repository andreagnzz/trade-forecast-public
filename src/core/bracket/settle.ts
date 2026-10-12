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
import { alertFailed, nextSeq, replace } from './legs';

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

// A fired exit closes part or all of the position: until its fills arrive, the open size is
// stale and nothing is placed against it.
const exitDue = (d: Bracket) =>
  d.sl.status === 'filling' || d.tp.status === 'filling' || d.close.status === 'filling';

const inFlight = (d: Bracket) =>
  LEGS.some((leg) => d[leg].status === 'sending' || d[leg].status === 'canceling');

// Unfilled or flat: stop the entry first and wait for its final size. A fill that lands in
// between reopens the position, and the stop is still there to cover it.
function windDown(d: Bracket, outcome: NonNullable<Bracket['outcome']>): BracketCommand[] {
  if (d.entry.status === 'live') return cancelLive(d, ['entry']);
  // An entry the exchange has no record of may still land: only the trader's dismiss ends it.
  if (d.attention === 'entry_unknown') return [];
  if (d.entry.status !== 'idle' && !entryFinished(d)) return [];
  const commands = cancelLive(d, LEGS);
  if (!inFlight(d)) d.outcome = outcome;
  return commands;
}

function protect(d: Bracket): BracketCommand[] {
  // Fills the entry announced but that have not arrived yet are exposure too.
  const exposed = openSize(d) > 0 || d.entry.status === 'live' || d.entry.size > d.filledSz;
  if (d.sl.status === 'done' && exposed && d.attention !== 'sl_failed' && !exitDue(d))
    replace(d, 'sl');
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
  const blocked = isTpAttention(d.attention) || d.close.status === 'sending' || exitDue(d);
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
  const prev = { seq: tp.seq, size: tp.size, px: tp.sentPx };
  // Out of seqs: the take-profit keeps resting as it is, and the user picks what comes next.
  if (!nextSeq(d, 'tp')) {
    alertFailed(d, 'tp');
    return [];
  }
  Object.assign(tp, { prev, status: 'sending', size, sentPx: tp.px });
  return [{ type: 'modify', cloid, next: legCloid(d, 'tp'), order }];
}

// Drives the exchange toward the state the bracket needs. Live events and reconstruction both
// end here, so a reload resumes with the same rules as a running tab.
export function settle(d: Bracket): BracketCommand[] {
  if (d.cancelling) return windDown(d, { kind: 'cancelled', reason: d.cancelling });
  if (isFlat(d)) return windDown(d, { kind: 'closed' });
  return [...protect(d), ...takeProfit(d)];
}
