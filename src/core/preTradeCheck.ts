import {
  lossLimitReached,
  updateLock,
  type DayStats,
  type LockReason,
  type RulesState,
} from './rules';

export type OrderIntent =
  | { kind: 'place'; reduceOnly: boolean }
  | { kind: 'modify'; reduceOnly: boolean }
  | { kind: 'cancel' };

interface PreTradeVerdict {
  verdict: 'allow' | 'warn' | 'block';
  reasons: (LockReason | 'loss_limit_reached')[];
  state: RulesState;
}

function decide(
  order: OrderIntent,
  { rules, lock }: RulesState,
  dayPnlUsd: number,
): Omit<PreTradeVerdict, 'state'> {
  if (order.kind === 'cancel' || order.reduceOnly) return { verdict: 'allow', reasons: [] };
  if (lock) return { verdict: 'block', reasons: [lock.reason] };
  if (lossLimitReached(rules, dayPnlUsd)) {
    return { verdict: 'warn', reasons: ['loss_limit_reached'] };
  }
  return { verdict: 'allow', reasons: [] };
}

// The returned state carries the latched lock; callers persist it.
// Cancels and reduce-only orders (placed or modified) must always pass: the lock often fires
// at the very moment the SL closes the losing trade, and the OCO cancel of the TP must still go out.
export function preTradeCheck(
  order: OrderIntent,
  state: RulesState,
  stats: DayStats,
  now: number,
): PreTradeVerdict {
  const latched = updateLock(state, stats, now);
  return { ...decide(order, latched, stats.dayPnlUsd), state: latched };
}
