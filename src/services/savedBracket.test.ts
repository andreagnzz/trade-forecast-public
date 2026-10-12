import { describe, expect, it } from 'vitest';
import { openBracket, type BracketPlan } from '../core/bracket/bracket';
import { APP_PREFIX } from '../core/bracket/cloid';
import { readSaved } from './savedBracket';

const PLAN: BracketPlan = {
  id: '0123456789abcdef01234567',
  prefix: APP_PREFIX,
  coin: 'BTC',
  side: 'long',
  entry: { type: 'ioc', px: 80_160 },
  size: 0.003,
  szDecimals: 5,
  minNotionalUsd: 10,
  stopPx: 79_000,
  tpPx: 82_000,
  riskUsd: 3.5,
};
const saved = { version: 4, since: 1_760_000_000_000, bracket: openBracket(PLAN).state };

describe('readSaved', () => {
  it('reads back a saved bracket', () => {
    expect(readSaved(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([
    ['nothing stored', null],
    ['invalid JSON', '{'],
    ['another version', JSON.stringify({ ...saved, version: 3 })],
    ['no plan', JSON.stringify({ ...saved, bracket: { ...saved.bracket, plan: null } })],
    [
      'a plan without a string id',
      JSON.stringify({ ...saved, bracket: { ...saved.bracket, plan: { ...PLAN, id: 1 } } }),
    ],
    ['a missing leg', JSON.stringify({ ...saved, bracket: { ...saved.bracket, tp: undefined } })],
  ])('drops %s', (_case, raw) => {
    expect(readSaved(raw)).toBeNull();
  });
});
