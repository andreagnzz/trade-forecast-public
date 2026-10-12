import { exitIsBuy, roundSize, type Bracket, type BracketFill } from './bracket';
import { parseCloid, type LegName } from './cloid';

// One of this bracket's orders, whatever its seq.
export function ownLeg(d: Bracket, cloid: string) {
  const parsed = parseCloid(cloid);
  if (parsed?.prefix !== d.plan.prefix || parsed.bracketId !== d.plan.id) return null;
  return parsed;
}

// Events are keyed by cloid; a stale seq (the order a modify replaced, a lost leg) is ignored.
export function currentLeg(d: Bracket, cloid: string): LegName | null {
  const parsed = ownLeg(d, cloid);
  if (!parsed) return null;
  return d[parsed.leg].seq === parsed.seq ? parsed.leg : null;
}

// HL does not deduplicate cloids, so a sent cloid is never sent again: the next order of a
// leg always takes the next seq.
export function replace(d: Bracket, leg: LegName, status: 'idle' | 'done' = 'idle') {
  d[leg].seq += 1;
  d[leg].status = status;
  if (leg === 'sl') d.sl.closedSz = 0;
}

// A modify that did not land leaves the previous take-profit resting: track it again.
export function revertTp(d: Bracket) {
  const { prev } = d.tp;
  if (!prev) return;
  Object.assign(d.tp, {
    seq: prev.seq,
    size: prev.size,
    sentPx: prev.px,
    status: 'live',
    prev: null,
  });
}

export function applyFill(d: Bracket, fill: BracketFill) {
  if (d.tids.includes(fill.tid)) return;
  d.tids.push(fill.tid);
  d.pnlUsd += fill.closedPnl - fill.fee;
  if (fill.isBuy === exitIsBuy(d)) {
    d.exitedSz = roundSize(d, d.exitedSz + fill.size);
    const parsed = fill.cloid === null ? null : ownLeg(d, fill.cloid);
    if (parsed?.leg === 'sl' && parsed.seq === d.sl.seq) {
      d.sl.closedSz = roundSize(d, d.sl.closedSz + fill.size);
      if (d.sl.status === 'filling' && d.sl.closedSz >= d.sl.size) d.sl.status = 'done';
      return;
    }
    // HL shrinks a partly filled take-profit on its own: track what still rests.
    if (parsed?.leg !== 'tp') return;
    // The order a modify is replacing can still fill until the modify lands.
    const { prev } = d.tp;
    if (parsed.seq === prev?.seq) prev.size = roundSize(d, prev.size - fill.size);
    if (parsed.seq !== d.tp.seq) return;
    d.tp.size = roundSize(d, d.tp.size - fill.size);
    if (d.tp.size <= 0) d.tp.status = 'done';
    return;
  }
  d.filledSz = roundSize(d, d.filledSz + fill.size);
  if (d.attention === 'entry_unknown') d.attention = null;
  // Exposure exists after all: protect it rather than finish the cancel.
  d.cancelling = null;
}
