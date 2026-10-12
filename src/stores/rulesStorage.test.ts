import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialRulesState, type RulesState } from '../core/rules';
import { loadRules } from './rulesStorage';

const MASTER = '0x0000000000000000000000000000000000000001';

const stored = (value: unknown) => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value) });
};

const locked: RulesState = {
  rules: { oneBullet: true, lossLimit: { usd: 50, hard: true } },
  pending: null,
  lock: { reason: 'loss_limit', until: Date.UTC(2026, 9, 13) },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadRules', () => {
  it('restores valid saved rules and their lock', () => {
    stored(locked);
    expect(loadRules(MASTER)).toEqual(locked);
  });

  it.each([
    [
      'a zero loss limit',
      { ...locked, rules: { ...locked.rules, lossLimit: { usd: 0, hard: true } } },
    ],
    [
      'a negative loss limit',
      { ...locked, rules: { ...locked.rules, lossLimit: { usd: -50, hard: true } } },
    ],
    [
      'a pending zero loss limit',
      {
        ...locked,
        pending: { rules: { oneBullet: false, lossLimit: { usd: 0, hard: false } }, from: 0 },
      },
    ],
    ['an unknown lock reason', { ...locked, lock: { reason: 'paused', until: 0 } }],
  ])('falls back to the defaults on %s', (_, value) => {
    stored(value);
    expect(loadRules(MASTER)).toEqual(initialRulesState);
  });
});
