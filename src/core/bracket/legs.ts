import { exitIsBuy, roundSize, type Attention, type Bracket, type BracketFill } from './bracket';
import { isCloid, parseCloid, type Cloid, type LegName } from './cloid';

// One of this bracket's orders, whatever its seq.
function ownLeg(d: Bracket, cloid: string) {
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

// An order of this bracket under a seq it no longer tracks, such as a lost request that landed
// late. The order a modify in flight replaces still rests until the modify lands.
export function isStale(d: Bracket, cloid: string): cloid is Cloid {
  const parsed = ownLeg(d, cloid);
  if (!parsed || !isCloid(cloid) || currentLeg(d, cloid)) return false;
  return !(parsed.leg === 'tp' && parsed.seq === d.tp.prev?.seq);
}

type ExitLeg = 'sl' | 'tp' | 'close';

const FAILED = { sl: 'sl_failed', tp: 'tp_failed', close: 'close_failed' } as const;

// HL does not deduplicate cloids, so a sent cloid is never sent again: the next order of a
// leg takes a seq above any it used. A cloid holds the seq in one byte.
export function nextSeq(d: Bracket, leg: ExitLeg) {
  const state = d[leg];
  if (state.maxSeq >= 255) return false;
  state.maxSeq += 1;
  state.seq = state.maxSeq;
  return true;
}

// sl_failed holds back every automatic stop order until the trader acts: nothing replaces it.
export function alert(d: Bracket, attention: Attention) {
  if (d.attention !== 'sl_failed') d.attention = attention;
}

export function alertFailed(d: Bracket, leg: ExitLeg) {
  alert(d, FAILED[leg]);
}

// Before the entry is sent nothing is exposed, so a stop that cannot be placed ends the bracket.
export function giveUp(d: Bracket, leg: ExitLeg) {
  d[leg].status = 'done';
  if (leg === 'sl' && d.entry.status === 'idle') d.cancelling ??= 'sl_rejected';
  else alertFailed(d, leg);
}

// A leg that has used every seq gives up.
export function replace(d: Bracket, leg: ExitLeg, status: 'idle' | 'waiting' = 'idle') {
  if (!nextSeq(d, leg)) {
    giveUp(d, leg);
    return false;
  }
  d[leg].status = status;
  if (leg === 'sl' || leg === 'close') d[leg].closedSz = 0;
  return true;
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
  // Failures count toward giving up only while the position stays the same.
  d.sl.retries = 0;
  d.tp.retries = 0;
  d.pnlUsd += fill.closedPnl - fill.fee;
  if (fill.isBuy === exitIsBuy(d)) {
    d.exitedSz = roundSize(d, d.exitedSz + fill.size);
    const parsed = fill.cloid === null ? null : ownLeg(d, fill.cloid);
    if ((parsed?.leg === 'sl' || parsed?.leg === 'close') && parsed.seq === d[parsed.leg].seq) {
      const exit = d[parsed.leg];
      exit.closedSz = roundSize(d, exit.closedSz + fill.size);
      if (exit.status === 'filling' && exit.closedSz >= exit.size) exit.status = 'done';
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
