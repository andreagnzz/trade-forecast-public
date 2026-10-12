import { describe, expect, it } from 'vitest';
import type { SendResult } from '../services/orderService';
import { strayNotice } from './execution';

describe('strayNotice', () => {
  it.each<[SendResult, string | null]>([
    [
      { status: 'rejected', error: { code: 'ReduceOnly', message: '' } },
      'rejected: reduce-only would increase position',
    ],
    [{ status: 'uncertain' }, 'uncertain: check open orders'],
    [{ status: 'filled', filledSz: 0.01 }, null],
  ])('tells the trader what became of a stray close or cancel (%j)', (result, notice) => {
    expect(strayNotice(result)).toBe(notice);
  });
});
