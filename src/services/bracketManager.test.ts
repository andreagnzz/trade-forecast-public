import { describe, expect, it } from 'vitest';
import type { BracketPlan, OrderSpec } from '../core/bracket/bracket';
import { makeCloid, parseCloid, type Cloid, type LegName } from '../core/bracket/cloid';
import { changeRules, initialRulesState, type DayStats, type RulesState } from '../core/rules';
import type { AccountFill, AccountOrder } from '../hl/account';
import type { QueryResult } from '../hl/exchange';
import type { OrderResult } from '../hl/orders';
import { createBracketManager, type BracketView } from './bracketManager';
import { createOrderService } from './orderService';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const NOW = Date.UTC(2026, 9, 12, 12);
const PLAN: BracketPlan = {
  id: ID,
  prefix: '7466',
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
const MARK = 80_050;
const c = (leg: LegName, seq = 0) => makeCloid('7466', ID, leg, seq);

interface Exchange {
  calls: string[];
  answers: Partial<Record<LegName, OrderResult>>;
  status: Partial<Record<Cloid, QueryResult>>;
  open: AccountOrder[];
  fills: AccountFill[];
  positionSz: number;
}

function setup(
  options: {
    stats?: DayStats;
    storage?: Map<string, string>;
    exchange?: Exchange;
    failReads?: boolean;
  } = {},
) {
  const exchange: Exchange = options.exchange ?? {
    calls: [],
    answers: {},
    status: {},
    open: [],
    fills: [],
    positionSz: 0,
  };
  const storage = options.storage ?? new Map<string, string>();
  const changed = changeRules(initialRulesState, { oneBullet: true }, NOW);
  if (!changed.ok) throw new Error(changed.error);
  let rules: RulesState = changed.state;
  const answer = (cloid: Cloid): OrderResult => {
    const leg = parseCloid(cloid)?.leg;
    return (leg && exchange.answers[leg]) ?? { status: 'resting' };
  };
  const client = {
    place: (coin: string, cloid: Cloid, spec: OrderSpec) => {
      if (coin === 'NOPE') throw new Error('boom');
      exchange.calls.push(`place ${parseCloid(cloid)?.leg ?? '?'} ${String(spec.size)}`);
      return Promise.resolve(answer(cloid));
    },
    modify: (_coin: string, _cloid: Cloid, next: Cloid, spec: OrderSpec) => {
      exchange.calls.push(`modify ${parseCloid(next)?.leg ?? '?'} ${String(spec.size)}`);
      return Promise.resolve<OrderResult>({ status: 'resting' });
    },
    cancel: (_coin: string, cloid: Cloid) => {
      exchange.calls.push(`cancel ${parseCloid(cloid)?.leg ?? '?'}`);
      return Promise.resolve<OrderResult>({ status: 'canceled' });
    },
    orderStatus: (_coin: string, cloid: Cloid) => {
      exchange.calls.push(`query ${parseCloid(cloid)?.leg ?? '?'}`);
      return Promise.resolve(exchange.status[cloid] ?? { kind: 'unknown' as const });
    },
  };
  const orders = createOrderService({
    client,
    rules: {
      load: () => rules,
      save: (state) => {
        rules = state;
      },
    },
    stats: () => Promise.resolve(options.stats ?? { trips: [], dayPnlUsd: 0 }),
    now: () => NOW,
  });
  let view: BracketView = { bracket: null, lastError: null };
  const timers: (() => void)[] = [];
  const manager = createBracketManager({
    orders,
    client,
    reads: {
      openOrders: () =>
        options.failReads
          ? Promise.reject(new Error('network down'))
          : Promise.resolve(exchange.open),
      fills: () => Promise.resolve(exchange.fills),
      position: () =>
        Promise.resolve({
          size: exchange.positionSz,
          isLong: true,
          unrealizedPnl: 0,
          time: NOW,
        }),
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    storageKey: 'bracket',
    clock: {
      setTimeout: (run: () => void) => {
        timers.push(run);
      },
    },
    onChange: (next) => {
      view = next;
    },
  });
  return { manager, exchange, storage, timers, view: () => view };
}

const entryFill = (tid: number, sz: number): AccountFill => ({
  tid,
  coin: 'BTC',
  time: NOW + 1,
  side: 'buy',
  sz,
  px: 80_100,
  startPosition: 0,
  closedPnl: 0,
  fee: 0.01,
  cloid: c('entry'),
});

describe('BracketManager', () => {
  it('places the stop, then the entry, then the take-profit at the filled size', async () => {
    const { manager, exchange, view } = setup();
    exchange.answers.entry = { status: 'filled', filledSz: 0.003 };
    expect(await manager.send(PLAN, MARK)).toBeNull();
    await manager.settled();
    manager.onFills([entryFill(1, 0.003)]);
    await manager.settled();
    expect(exchange.calls).toEqual(['place sl 0', 'place entry 0.003', 'place tp 0.003']);
    expect(view().bracket?.tp.status).toBe('live');
  });

  it('refuses a coin that already holds a position or an order', async () => {
    const { manager, exchange } = setup();
    exchange.positionSz = 0.01;
    expect(await manager.send(PLAN, MARK)).toBe('coin_busy');
    exchange.positionSz = 0;
    exchange.open = [{ coin: 'BTC', cloid: null, size: 1, reduceOnly: false }];
    expect(await manager.send(PLAN, MARK)).toBe('coin_busy');
    expect(exchange.calls).toEqual([]);
  });

  it('refuses a second bracket while one is running', async () => {
    const { manager } = setup();
    await manager.send(PLAN, MARK);
    expect(await manager.send({ ...PLAN, id: 'ffffffffffffffffffffffff' }, MARK)).toBe(
      'bracket_active',
    );
  });

  it('refuses before placing anything once the rules are locked', async () => {
    const loss = { coin: 'BTC', openTime: NOW - 2000, closeTime: NOW - 1000, netPnl: -1 };
    const { manager, exchange } = setup({ stats: { trips: [loss], dayPnlUsd: -1 } });
    expect(await manager.send(PLAN, MARK)).toBe('blocked');
    expect(exchange.calls).toEqual([]);
  });

  it('queries an entry whose answer was lost and never sends it twice', async () => {
    const { manager, exchange, view } = setup();
    exchange.answers.entry = { status: 'uncertain' };
    await manager.send(PLAN, MARK);
    await manager.settled();
    expect(exchange.calls).toEqual(['place sl 0', 'place entry 0.003', 'query entry']);
    expect(view().bracket?.attention).toBe('entry_unknown');
  });

  it('turns a crossing take-profit into a user choice with a readable reason', async () => {
    const { manager, exchange, view } = setup();
    exchange.answers.entry = { status: 'filled', filledSz: 0.003 };
    exchange.answers.tp = {
      status: 'rejected',
      error: { code: 'BadAloPx', message: 'Post only order would have immediately matched' },
    };
    await manager.send(PLAN, MARK);
    await manager.settled();
    manager.onFills([entryFill(1, 0.003)]);
    await manager.settled();
    expect(view().bracket?.attention).toBe('tp_would_cross');
    expect(view().lastError).toBe('rejected: post-only would cross');
  });

  it('applies order updates from the socket and ignores other brackets', async () => {
    const { manager, view } = setup();
    await manager.send(PLAN, MARK);
    await manager.settled();
    manager.onOrderUpdate({
      cloid: makeCloid('7466', 'f'.repeat(24), 'sl', 0),
      coin: 'BTC',
      status: 'canceled',
      origSz: '0',
      sz: '0',
    });
    expect(view().bracket?.sl.status).toBe('live');
    manager.onOrderUpdate({
      cloid: c('sl'),
      coin: 'BTC',
      status: 'canceled',
      origSz: '0.0',
      sz: '0.0',
    });
    expect(view().bracket?.sl.seq).toBe(1);
  });

  it('resumes after a reload from storage and the book, without duplicating orders', async () => {
    const first = setup();
    first.exchange.answers.entry = { status: 'filled', filledSz: 0.003 };
    await first.manager.send(PLAN, MARK);
    await first.manager.settled();
    const exchange: Exchange = {
      ...first.exchange,
      calls: [],
      open: [{ coin: 'BTC', cloid: c('sl'), size: 0, reduceOnly: true }],
      fills: [entryFill(7, 0.003)],
    };
    const reloaded = setup({ storage: first.storage, exchange });
    await reloaded.manager.load();
    await reloaded.manager.settled();
    expect(exchange.calls).toEqual(['place tp 0.003']);
    expect(reloaded.view().bracket?.filledSz).toBe(0.003);
  });

  it('drops a saved bracket that breaks on reload, without sending anything', async () => {
    const first = setup();
    first.exchange.answers.entry = { status: 'filled', filledSz: 0.003 };
    await first.manager.send(PLAN, MARK);
    await first.manager.settled();
    const stored = JSON.parse(first.storage.get('bracket') ?? '') as { bracket: object };
    first.storage.set(
      'bracket',
      JSON.stringify({ ...stored, bracket: { ...stored.bracket, tids: undefined } }),
    );
    const exchange: Exchange = { ...first.exchange, calls: [], fills: [entryFill(7, 0.003)] };
    const reloaded = setup({ storage: first.storage, exchange });
    await reloaded.manager.load();
    await reloaded.manager.settled();
    expect(exchange.calls).toEqual([]);
    expect(reloaded.view().bracket).toBeNull();
    expect(reloaded.view().lastError).toBe('saved bracket unreadable, dropped: check open orders');
    expect(first.storage.has('bracket')).toBe(false);
  });

  it('forgets a finished bracket so the next one can start', async () => {
    const { manager, exchange, storage } = setup();
    exchange.answers.entry = { status: 'filled', filledSz: 0 };
    await manager.send(PLAN, MARK);
    await manager.settled();
    expect(exchange.calls).toEqual(['place sl 0', 'place entry 0.003', 'cancel sl']);
    expect(storage.has('bracket')).toBe(false);
    expect(await manager.send({ ...PLAN, id: 'ffffffffffffffffffffffff' }, MARK)).toBeNull();
  });

  it('drops an unreadable or older saved bracket, says so, and still sends', async () => {
    for (const raw of ['{not json', JSON.stringify({ version: 1, since: 0, bracket: {} })]) {
      const storage = new Map([['bracket', raw]]);
      const { manager, view } = setup({ storage });
      await manager.load();
      expect(storage.has('bracket')).toBe(false);
      expect(view().lastError).toBe('saved bracket unreadable, dropped: check open orders');
      expect(await manager.send(PLAN, MARK)).toBeNull();
    }
  });

  it('keeps the queue running after one command throws, says so, and checks the order', async () => {
    const { manager, exchange, view } = setup();
    await manager.send({ ...PLAN, coin: 'NOPE' }, MARK);
    await manager.settled();
    expect(view().lastError).toBe('internal error: boom');
    expect(exchange.calls).toEqual(['query sl']);
  });

  it('starts one bracket only when Send is pressed twice quickly', async () => {
    const { manager, exchange } = setup();
    const [first, second] = await Promise.all([
      manager.send(PLAN, MARK),
      manager.send({ ...PLAN, id: 'ffffffffffffffffffffffff' }, MARK),
    ]);
    await manager.settled();
    expect([first, second]).toEqual([null, 'bracket_active']);
    expect(exchange.calls.filter((call) => call.startsWith('place sl'))).toHaveLength(1);
  });

  it.each([
    { side: 'long', stopPx: 79_000, mark: 78_990 },
    { side: 'long', stopPx: 79_000, mark: 79_000 },
    { side: 'short', stopPx: 81_000, mark: 81_010 },
  ] as const)(
    'refuses a $side stop the mark has already crossed',
    async ({ side, stopPx, mark }) => {
      const { manager, exchange } = setup();
      expect(await manager.send({ ...PLAN, side, stopPx }, mark)).toBe('stop_crossed');
      expect(exchange.calls).toEqual([]);
    },
  );

  it('reports a failed sync and tries again', async () => {
    const first = setup();
    await first.manager.send(PLAN, MARK);
    await first.manager.settled();
    const reloaded = setup({ storage: first.storage, failReads: true });
    await reloaded.manager.load();
    expect(reloaded.view().lastError).toContain('sync failed');
    expect(reloaded.timers).toHaveLength(1);
  });
});
