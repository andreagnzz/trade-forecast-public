import { LEGS, legCloid, type Bracket, type BracketCommand, type BracketEvent } from './bracket';
import { isCloid } from './cloid';
import { applyFill, currentLeg, ownLeg } from './legs';

function staleOrders(d: Bracket, open: { cloid: string }[]): BracketCommand[] {
  const commands: BracketCommand[] = [];
  for (const { cloid } of open) {
    const parsed = ownLeg(d, cloid);
    if (!parsed || !isCloid(cloid) || currentLeg(d, cloid)) continue;
    // The order a modify in flight replaces still rests until the modify lands.
    if (parsed.leg === 'tp' && parsed.seq === d.tp.prev?.seq) continue;
    commands.push({ type: 'cancel', cloid });
  }
  return commands;
}

// A leg still in flight may simply not have reached the book yet: ask, never assume it is gone.
export function reconcile(
  d: Bracket,
  event: Extract<BracketEvent, { type: 'snapshot' }>,
): BracketCommand[] {
  const commands = staleOrders(d, event.open);
  const book = new Map(event.open.map((o) => [o.cloid, o.size]));
  for (const leg of LEGS) {
    const state = d[leg];
    const size = book.get(legCloid(d, leg));
    if (size !== undefined) {
      // A cancel sent by the previous page may never have landed: send it again.
      if (state.status === 'canceling') commands.push({ type: 'cancel', cloid: legCloid(d, leg) });
      else state.status = 'live';
      if (leg === 'entry' && d.attention === 'entry_unknown') d.attention = null;
      if (leg === 'tp') Object.assign(d.tp, { size, prev: null });
    } else if (
      state.status === 'sending' ||
      // A fired exit whose fills the previous page never saw: its order status says what it closed.
      state.status === 'filling' ||
      // The snapshot may predate the leg reaching the book; a cancelled order stays queryable.
      state.status === 'live'
    ) {
      commands.push({ type: 'query', cloid: legCloid(d, leg) });
    } else if (state.status === 'canceling') {
      state.status = 'done';
    } else if (state.status === 'waiting') {
      // The retry timer died with the previous page.
      state.status = 'idle';
    } else if (leg === 'entry' && state.status === 'idle') {
      // Nothing was sent before the reload: the price has moved, so nothing is sent after it.
      state.status = 'done';
    }
  }
  for (const fill of event.fills) applyFill(d, fill);
  // An entry the exchange never saw stays the user's call: its stop stays until they dismiss.
  const unfilled =
    d.entry.status === 'done' &&
    d.entry.size === 0 &&
    d.filledSz === 0 &&
    d.attention !== 'entry_unknown';
  if (unfilled) d.cancelling ??= 'no_fill';
  return commands;
}
