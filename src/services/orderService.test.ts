import { describe, expect, it } from 'vitest';
import type { OrderSpec } from '../core/bracket/bracket';
import { makeCloid } from '../core/bracket/cloid';
import { changeRules, initialRulesState, type DayStats, type RulesState } from '../core/rules';
import { createOrderService } from './orderService';

const NOON = Date.UTC(2026, 9, 12, 12);
const CLOID = makeCloid('7466', 'a1b2c3d4e5f6a7b8c9d0e1f2', 'entry', 0);
const ENTRY: OrderSpec = { isBuy: true, px: 80_000, size: 0.001, reduceOnly: false, type: 'ioc' };
const TP: OrderSpec = { ...ENTRY, isBuy: false, reduceOnly: true, type: 'alo' };
const LOSS: DayStats = {
  trips: [{ coin: 'BTC', openTime: NOON - 2000, closeTime: NOON - 1000, netPnl: -0.4 }],
  dayPnlUsd: -0.4,
};

function setup(stats: DayStats) {
  const changed = changeRules(initialRulesState, { oneBullet: true }, NOON);
  if (!changed.ok) throw new Error(changed.error);
  let saved: RulesState = changed.state;
  const sent: string[] = [];
  const service = createOrderService({
    client: {
      place: (_coin, cloid) => {
        sent.push(`place ${cloid}`);
        return Promise.resolve({ status: 'resting' });
      },
      modify: (_coin, cloid) => {
        sent.push(`modify ${cloid}`);
        return Promise.resolve({ status: 'resting' });
      },
      cancel: (_coin, cloid) => {
        sent.push(`cancel ${cloid}`);
        return Promise.resolve({ status: 'canceled' });
      },
    },
    rules: {
      load: () => saved,
      save: (state) => {
        saved = state;
      },
    },
    stats: () => Promise.resolve(stats),
    now: () => NOON,
  });
  return { service, sent, saved: () => saved };
}

describe('OrderService', () => {
  it('refuses an exposure-increasing order once one bullet is spent, before signing', async () => {
    const { service, sent, saved } = setup(LOSS);
    const answer = await service.send('BTC', { type: 'place', cloid: CLOID, order: ENTRY });
    expect(answer).toEqual({ status: 'blocked', reasons: ['one_bullet'] });
    expect(sent).toEqual([]);
    expect(saved().lock?.reason).toBe('one_bullet');
  });

  it('refuses moving a resting entry once locked', async () => {
    const { service, sent } = setup(LOSS);
    const answer = await service.send('BTC', {
      type: 'modify',
      cloid: CLOID,
      next: CLOID,
      order: ENTRY,
    });
    expect(answer.status).toBe('blocked');
    expect(sent).toEqual([]);
  });

  it.each([
    { name: 'a cancel', command: { type: 'cancel', cloid: CLOID } as const },
    { name: 'a reduce-only place', command: { type: 'place', cloid: CLOID, order: TP } as const },
    {
      name: 'a reduce-only modify',
      command: { type: 'modify', cloid: CLOID, next: CLOID, order: TP } as const,
    },
  ])('always lets $name through, even locked', async ({ command }) => {
    const { service, sent } = setup(LOSS);
    expect((await service.send('BTC', command)).status).not.toBe('blocked');
    expect(sent).toHaveLength(1);
  });

  it('sends normally while the rules are armed', async () => {
    const { service, sent } = setup({ trips: [], dayPnlUsd: 0 });
    expect(await service.send('BTC', { type: 'place', cloid: CLOID, order: ENTRY })).toEqual({
      status: 'resting',
    });
    expect(sent).toEqual([`place ${CLOID}`]);
  });
});
