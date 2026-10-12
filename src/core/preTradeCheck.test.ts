import { describe, expect, it } from 'vitest';
import { preTradeCheck, type OrderIntent } from './preTradeCheck';
import { changeRules, initialRulesState, type Rules, type RulesState } from './rules';

const DAY = Date.UTC(2026, 9, 11);
const NOON = DAY + 43_200_000;
const NEXT_DAY = DAY + 86_400_000;
const losingTrip = { coin: 'BTC', openTime: NOON - 1000, closeTime: NOON, netPnl: -12 };

function withRules(patch: Partial<Rules>): RulesState {
  const changed = changeRules(initialRulesState, patch, DAY);
  if (!changed.ok) throw new Error(changed.error);
  return changed.state;
}

const entry: OrderIntent = { kind: 'place', reduceOnly: false };

describe('preTradeCheck', () => {
  const oneBullet = withRules({ oneBullet: true });
  const afterLoss = { trips: [losingTrip], dayPnlUsd: -12 };

  it('blocks an exposure-increasing order once the first losing round-trip closed today', () => {
    expect(preTradeCheck(entry, oneBullet, afterLoss, NOON)).toMatchObject({
      verdict: 'block',
      reasons: ['one_bullet'],
    });
  });

  it.each([
    { name: 'the OCO cancel of the TP', order: { kind: 'cancel' } },
    { name: 'a reduce-only SL modify', order: { kind: 'modify', reduceOnly: true } },
    { name: 'a reduce-only SL re-placement', order: { kind: 'place', reduceOnly: true } },
  ] as const)('always lets $name through while locked', ({ order }) => {
    expect(preTradeCheck(order, oneBullet, afterLoss, NOON)).toMatchObject({
      verdict: 'allow',
      reasons: [],
    });
  });

  it('blocks a modify of a resting entry while locked, since it can add exposure', () => {
    const modifyEntry: OrderIntent = { kind: 'modify', reduceOnly: false };
    expect(preTradeCheck(modifyEntry, oneBullet, afterLoss, NOON)).toMatchObject({
      verdict: 'block',
      reasons: ['one_bullet'],
    });
  });

  it('allows entries again at the next UTC day', () => {
    expect(preTradeCheck(entry, oneBullet, afterLoss, NEXT_DAY).verdict).toBe('allow');
  });

  it('blocks once a hard loss limit is exhausted', () => {
    const hard = withRules({ lossLimit: { usd: 300, hard: true } });
    expect(preTradeCheck(entry, hard, { trips: [], dayPnlUsd: -300 }, NOON)).toMatchObject({
      verdict: 'block',
      reasons: ['loss_limit'],
    });
  });

  it('returns the latched state so the lock survives a recovering unrealized PnL', () => {
    const hard = withRules({ lossLimit: { usd: 300, hard: true } });
    const first = preTradeCheck(entry, hard, { trips: [], dayPnlUsd: -300 }, NOON);
    const later = preTradeCheck(entry, first.state, { trips: [], dayPnlUsd: -250 }, NOON + 1);
    expect(later.verdict).toBe('block');
  });

  it('only warns once a soft loss limit is exhausted', () => {
    const soft = withRules({ lossLimit: { usd: 300, hard: false } });
    expect(preTradeCheck(entry, soft, { trips: [], dayPnlUsd: -300 }, NOON)).toMatchObject({
      verdict: 'warn',
      reasons: ['loss_limit_reached'],
    });
  });

  it('allows everything with the default rules', () => {
    expect(preTradeCheck(entry, initialRulesState, afterLoss, NOON).verdict).toBe('allow');
  });
});
