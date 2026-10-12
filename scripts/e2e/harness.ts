import { setTimeout as sleep } from 'node:timers/promises';
import type { BracketPlan, OrderSpec } from '../../src/core/bracket/bracket';
import { E2E_PREFIX, makeCloid, parseCloid } from '../../src/core/bracket/cloid';
import { initialRulesState, type RulesState } from '../../src/core/rules';
import {
  loadFills,
  loadFunding,
  loadOpenOrders,
  loadPosition,
  loadUnrealizedPnl,
  subscribeAccount,
} from '../../src/hl/account';
import { assertTestnet, connectAgent } from '../../src/hl/exchange';
import { exitPx, snapPrice, snapSize } from '../../src/hl/format';
import { loadInstrument, loadQuote } from '../../src/hl/marketData';
import { incrementalFills, loadDayStats } from '../../src/services/accountData';
import {
  createBracketManager,
  randomBracketId,
  type BracketManager,
  type BracketView,
} from '../../src/services/bracketManager';
import { createOrderService } from '../../src/services/orderService';

// The e2e account is a separate master with its own agent, so its losing round-trips never
// reach the demo account's PnL or rules.
const connected = await connectAgent(process.env.HL_E2E_AGENT_KEY ?? '');
if (!connected.ok) throw new Error(`e2e agent refused: ${connected.error}`);
assertTestnet();
const client = connected.client;
const master = client.master;

export const rules: { state: RulesState } = { state: initialRulesState };

export const reads = {
  openOrders: () => loadOpenOrders(master),
  fills: (since: number) => loadFills(master, since),
  position: (coin: string) => loadPosition(master, coin),
};

// The same incremental read as the app: the e2e account holds thousands of fills, and
// re-reading a week of them before every entry trips HL's rate limit.
const recentFills = incrementalFills(reads.fills);

export const dayStats = () =>
  loadDayStats(
    {
      fills: recentFills,
      funding: (since) => loadFunding(master, since),
      unrealizedPnl: () => loadUnrealizedPnl(master),
    },
    Date.now(),
  );

export const orders = createOrderService({
  client,
  rules: {
    load: () => rules.state,
    save: (state) => {
      rules.state = state;
    },
  },
  stats: dayStats,
  now: Date.now,
});

const managers = new Set<BracketManager>();
await subscribeAccount(master, 'BTC', {
  onOrder: (update) => {
    for (const manager of managers) manager.onOrderUpdate(update);
  },
  onFills: (fills) => {
    for (const manager of managers) manager.onFills(fills);
  },
  onPosition: () => undefined,
  onConnection: (open) => {
    if (!open) console.log('  ws closed');
  },
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

// Times are stamped when the manager first reports each state.
export function openSession(storage = memoryStorage()) {
  const marks: { slLive?: number; filled?: number; tpLive?: number } = {};
  let view: BracketView = { bracket: null, lastError: null };
  const manager = createBracketManager({
    orders,
    client,
    reads,
    storage,
    storageKey: 'e2e',
    clock: {
      setTimeout: (run, ms) => {
        setTimeout(run, ms);
      },
    },
    onChange: (next) => {
      view = next;
      const b = next.bracket;
      if (!b) return;
      const now = Date.now();
      if (b.sl.status === 'live') marks.slLive ??= now;
      if (b.filledSz > 0) marks.filled ??= now;
      if (b.tp.status === 'live') marks.tpLive ??= now;
    },
  });
  managers.add(manager);
  return {
    manager,
    storage,
    marks,
    view: () => view,
    dispose: () => managers.delete(manager),
  };
}

export async function waitFor(what: string, done: () => boolean, ms = 20_000) {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

export async function market(coin: string) {
  const [spec, quote] = await Promise.all([
    loadInstrument(coin, 'testnet'),
    loadQuote(coin, 'testnet'),
  ]);
  return {
    ...quote,
    markPx: spec.markPx,
    szDecimals: spec.szDecimals,
    px: (x: number) => snapPrice(x, spec.szDecimals),
    sz: (x: number) => snapSize(x, spec.szDecimals),
  };
}

export async function longPlan(
  coin: string,
  options: { type: 'ioc' | 'gtc'; usd?: number; entryPx?: number; stopPx?: number; tpPx?: number },
): Promise<BracketPlan> {
  const m = await market(coin);
  const entryPx = options.entryPx ?? m.px(m.ask * 1.002);
  const stopPx = options.stopPx ?? m.px(m.bid * 0.98);
  const size = m.sz((options.usd ?? 15) / m.ask + 10 ** -m.szDecimals);
  return {
    id: randomBracketId(),
    prefix: E2E_PREFIX,
    coin,
    side: 'long',
    entry: { type: options.type, px: entryPx },
    size,
    szDecimals: m.szDecimals,
    minNotionalUsd: 10,
    stopPx,
    tpPx: options.tpPx ?? m.px(m.ask * 1.02),
    riskUsd: size * (entryPx - stopPx),
  };
}

// A generous slippage cap so cleanup and outside closes fill on a thin testnet book.
const CLOSE_SLIPPAGE = 0.01;

export async function closePx(coin: string, isBuy: boolean) {
  const m = await market(coin);
  return exitPx(m, isBuy, CLOSE_SLIPPAGE, m.szDecimals);
}

// Leaves the coin flat with no e2e order resting, whatever a failed run left behind.
export async function flatten(coin: string) {
  for (const o of await reads.openOrders()) {
    if (o.coin === coin && o.cloid && parseCloid(o.cloid)?.prefix === E2E_PREFIX) {
      await orders.send(coin, { type: 'cancel', cloid: o.cloid });
    }
  }
  const position = await reads.position(coin);
  if (position.size === 0) return;
  const isBuy = !position.isLong;
  const order: OrderSpec = {
    isBuy,
    px: await closePx(coin, isBuy),
    size: position.size,
    reduceOnly: true,
    type: 'ioc',
  };
  await orders.send(coin, {
    type: 'place',
    cloid: makeCloid(E2E_PREFIX, randomBracketId(), 'close', 0),
    order,
  });
}

export async function appOrders(id: string) {
  return (await reads.openOrders()).filter(
    (o) => o.cloid !== null && parseCloid(o.cloid)?.bracketId === id,
  );
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
