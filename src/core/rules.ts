import { budgetRemainingUsd, nextUtcDayStart, utcDayStart } from './budget';
import type { RoundTrip } from './roundtrips';

export interface Rules {
  oneBullet: boolean;
  lossLimit: { usd: number; hard: boolean } | null;
}

export type LockReason = 'one_bullet' | 'loss_limit';

export interface RulesState {
  rules: Rules;
  pending: { rules: Rules; from: number } | null;
  lock: { reason: LockReason; until: number } | null;
}

export interface DayStats {
  trips: readonly RoundTrip[];
  dayPnlUsd: number;
}

type RulesChange = { ok: true; state: RulesState } | { ok: false; error: 'invalid_loss_limit' };

export const initialRulesState: RulesState = {
  rules: { oneBullet: false, lossLimit: null },
  pending: null,
  lock: null,
};

export function resolveRules(state: RulesState, now: number): RulesState {
  const lock = state.lock && now < state.lock.until ? state.lock : null;
  if (state.pending && now >= state.pending.from) {
    return { rules: state.pending.rules, pending: null, lock };
  }
  return { ...state, lock };
}

// Tightening takes effect now; loosening waits for the next UTC day.
function stricter(current: Rules, next: Rules): Rules {
  return {
    oneBullet: current.oneBullet || next.oneBullet,
    lossLimit: current.lossLimit?.hard
      ? { usd: Math.min(current.lossLimit.usd, next.lossLimit?.usd ?? Infinity), hard: true }
      : next.lossLimit,
  };
}

const sameRules = (a: Rules, b: Rules) =>
  a.oneBullet === b.oneBullet &&
  a.lossLimit?.usd === b.lossLimit?.usd &&
  a.lossLimit?.hard === b.lossLimit?.hard;

// The patch applies on top of any pending change, so editing one field keeps a scheduled
// loosening of another.
export function changeRules(state: RulesState, patch: Partial<Rules>, now: number): RulesChange {
  const usd = patch.lossLimit?.usd;
  if (usd !== undefined && !(Number.isFinite(usd) && usd > 0)) {
    return { ok: false, error: 'invalid_loss_limit' };
  }
  const current = resolveRules(state, now);
  const next = { ...(current.pending?.rules ?? current.rules), ...patch };
  const rules = stricter(current.rules, next);
  const pending = sameRules(rules, next) ? null : { rules: next, from: nextUtcDayStart(now) };
  return { ok: true, state: { ...current, rules, pending } };
}

export function lossLimitReached(rules: Rules, dayPnlUsd: number): boolean {
  return rules.lossLimit !== null && budgetRemainingUsd(rules.lossLimit.usd, dayPnlUsd) === 0;
}

function lockReason(rules: Rules, stats: DayStats, now: number): LockReason | null {
  const dayStart = utcDayStart(now);
  // `!(netPnl >= 0)` also locks on a NaN PnL: an unknown result fails closed.
  if (rules.oneBullet && stats.trips.some((t) => t.closeTime >= dayStart && !(t.netPnl >= 0))) {
    return 'one_bullet';
  }
  return rules.lossLimit?.hard && lossLimitReached(rules, stats.dayPnlUsd) ? 'loss_limit' : null;
}

// The lock is latched: a recovering unrealized PnL must not unlock before midnight. Run it on
// every fill and PnL update, not only before orders, or a breach that recovers between two
// orders never latches.
export function updateLock(state: RulesState, stats: DayStats, now: number): RulesState {
  const current = resolveRules(state, now);
  if (current.lock) return current;
  const reason = lockReason(current.rules, stats, now);
  return reason ? { ...current, lock: { reason, until: nextUtcDayStart(now) } } : current;
}
