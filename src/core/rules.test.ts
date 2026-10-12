import { describe, expect, it } from 'vitest';
import type { RoundTrip } from './roundtrips';
import {
  changeRules,
  initialRulesState,
  resolveRules,
  updateLock,
  type Rules,
  type RulesState,
} from './rules';

const DAY = Date.UTC(2026, 9, 11);
const NEXT_DAY = DAY + 86_400_000;
const NOON = DAY + 43_200_000;

const trip = (closeTime: number, netPnl: number): RoundTrip => ({
  coin: 'BTC',
  openTime: closeTime - 1000,
  closeTime,
  netPnl,
});

function change(state: RulesState, patch: Partial<Rules>, now: number): RulesState {
  const changed = changeRules(state, patch, now);
  if (!changed.ok) throw new Error(changed.error);
  return changed.state;
}

const withRules = (patch: Partial<Rules>, now = DAY) => change(initialRulesState, patch, now);

describe('one bullet', () => {
  it('locks until the next UTC midnight after a losing round-trip closed today', () => {
    const state = updateLock(
      withRules({ oneBullet: true }),
      { trips: [trip(NOON, -0.01)], dayPnlUsd: 0 },
      NOON,
    );
    expect(state.lock).toEqual({ reason: 'one_bullet', until: NEXT_DAY });
  });

  it.each([
    { name: 'a winning round-trip', trips: [trip(NOON, 5)] },
    { name: 'a loss closed yesterday', trips: [trip(DAY - 1, -5)] },
    { name: 'no round-trip', trips: [] },
  ])('stays armed after $name', ({ trips }) => {
    expect(
      updateLock(withRules({ oneBullet: true }), { trips, dayPnlUsd: 0 }, NOON).lock,
    ).toBeNull();
  });

  it('locks on a round-trip whose PnL is unknown', () => {
    const state = updateLock(
      withRules({ oneBullet: true }),
      { trips: [trip(NOON, Number.NaN)], dayPnlUsd: 0 },
      NOON,
    );
    expect(state.lock?.reason).toBe('one_bullet');
  });

  it('does nothing while disabled, which is the default', () => {
    const state = updateLock(initialRulesState, { trips: [trip(NOON, -5)], dayPnlUsd: -500 }, NOON);
    expect(state.lock).toBeNull();
  });

  it('unlocks at the next UTC day', () => {
    const locked = updateLock(
      withRules({ oneBullet: true }),
      { trips: [trip(NOON, -5)], dayPnlUsd: 0 },
      NOON,
    );
    expect(resolveRules(locked, NEXT_DAY - 1).lock).not.toBeNull();
    expect(resolveRules(locked, NEXT_DAY).lock).toBeNull();
  });
});

describe('hard loss limit', () => {
  const hard = withRules({ lossLimit: { usd: 300, hard: true } });

  it('locks once the budget is exhausted and stays locked if unrealized PnL recovers', () => {
    const locked = updateLock(hard, { trips: [], dayPnlUsd: -300 }, NOON);
    expect(locked.lock).toEqual({ reason: 'loss_limit', until: NEXT_DAY });
    expect(updateLock(locked, { trips: [], dayPnlUsd: 0 }, NOON + 1).lock).toEqual(locked.lock);
  });

  it('stays armed while budget remains', () => {
    expect(updateLock(hard, { trips: [], dayPnlUsd: -299 }, NOON).lock).toBeNull();
  });

  it('never locks on a soft limit', () => {
    const soft = withRules({ lossLimit: { usd: 300, hard: false } });
    expect(updateLock(soft, { trips: [], dayPnlUsd: -1000 }, NOON).lock).toBeNull();
  });
});

describe('changeRules', () => {
  it('applies a tightening immediately', () => {
    expect(withRules({ oneBullet: true }, NOON).rules.oneBullet).toBe(true);
  });

  it('defers a loosening to the next UTC day', () => {
    const state = change(withRules({ oneBullet: true }), { oneBullet: false }, NOON);
    expect(resolveRules(state, NEXT_DAY - 1).rules.oneBullet).toBe(true);
    expect(resolveRules(state, NEXT_DAY).rules.oneBullet).toBe(false);
  });

  it('splits a mixed change: the stricter part now, the rest at midnight', () => {
    const hard = withRules({ lossLimit: { usd: 300, hard: true } });
    const state = change(hard, { oneBullet: true, lossLimit: { usd: 500, hard: true } }, NOON);
    expect(state.rules).toEqual({ oneBullet: true, lossLimit: { usd: 300, hard: true } });
    expect(resolveRules(state, NEXT_DAY).rules.lossLimit?.usd).toBe(500);
  });

  it.each([
    { name: 'lowering a hard limit', limit: { usd: 200, hard: true }, expected: 200 },
    { name: 'raising a hard limit', limit: { usd: 500, hard: true }, expected: 300 },
    { name: 'softening a hard limit', limit: { usd: 300, hard: false }, expected: 300 },
    { name: 'removing a hard limit', limit: null, expected: 300 },
  ])('treats $name by strictness', ({ limit, expected }) => {
    const hard = withRules({ lossLimit: { usd: 300, hard: true } });
    const state = change(hard, { lossLimit: limit }, NOON);
    expect(state.rules.lossLimit).toEqual({ usd: expected, hard: true });
  });

  it('changes a soft limit immediately in both directions', () => {
    const soft = withRules({ lossLimit: { usd: 300, hard: false } });
    const raised = change(soft, { lossLimit: { usd: 500, hard: false } }, NOON);
    expect(raised.rules.lossLimit?.usd).toBe(500);
    expect(change(soft, { lossLimit: null }, NOON).rules.lossLimit).toBeNull();
  });

  it('drops a pending loosening when the user tightens back', () => {
    const loosening = change(withRules({ oneBullet: true }), { oneBullet: false }, NOON);
    expect(change(loosening, { oneBullet: true }, NOON + 1).pending).toBeNull();
  });

  it('keeps a pending loosening when another field changes', () => {
    const loosening = change(withRules({ oneBullet: true }), { oneBullet: false }, NOON);
    const edited = change(loosening, { lossLimit: { usd: 300, hard: false } }, NOON + 1);
    expect(resolveRules(edited, NEXT_DAY).rules).toEqual({
      oneBullet: false,
      lossLimit: { usd: 300, hard: false },
    });
  });

  it('offers no manual unlock: loosening a locked rule keeps the lock', () => {
    const locked = updateLock(
      withRules({ oneBullet: true }),
      { trips: [trip(NOON, -5)], dayPnlUsd: 0 },
      NOON,
    );
    expect(change(locked, { oneBullet: false }, NOON + 1).lock).toEqual(locked.lock);
  });

  it.each([
    { name: 'a non-positive limit', usd: 0 },
    { name: 'a NaN limit', usd: Number.NaN },
    { name: 'an infinite limit', usd: Infinity },
  ])('rejects $name', ({ usd }) => {
    const changed = changeRules(initialRulesState, { lossLimit: { usd, hard: true } }, NOON);
    expect(changed).toEqual({ ok: false, error: 'invalid_loss_limit' });
  });
});
