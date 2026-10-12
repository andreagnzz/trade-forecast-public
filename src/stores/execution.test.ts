import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { Bracket } from '../core/bracket/bracket';
import { APP_PREFIX, makeCloid } from '../core/bracket/cloid';
import { resting, working } from '../core/bracket/fixtures';
import { initialRulesState } from '../core/rules';
import { subscribeAccount } from '../hl/account';
import { connectAgent, type ExecutionClient } from '../hl/exchange';
import { createBracketManager, type BracketManager } from '../services/bracketManager';
import type { SendResult } from '../services/orderService';
import { useAccountStore } from './account';
import { strayNotice, strayOrders, useExecutionStore } from './execution';
import { useTerminalStore } from './terminal';

vi.mock('../hl/exchange', () => ({ connectAgent: vi.fn() }));
vi.mock('../hl/marketData', () => ({
  loadInstrument: () => new Promise(() => undefined),
  loadCandles: () => new Promise(() => undefined),
  loadQuote: () => new Promise(() => undefined),
  subscribeMarket: vi.fn(),
}));
vi.mock('../hl/account', () => ({
  loadFills: vi.fn(),
  loadFunding: vi.fn(),
  loadUnrealizedPnl: vi.fn(),
  loadLimits: vi.fn(),
  loadOpenOrders: vi.fn(),
  loadPosition: vi.fn(),
  loadProfile: () => Promise.resolve({ unified: false, fees: { taker: 0, maker: 0 } }),
  subscribeAccount: vi.fn(),
}));
vi.mock('../services/bracketManager', () => ({
  createBracketManager: vi.fn(),
  randomBracketId: vi.fn(),
}));

const MASTER = '0x0000000000000000000000000000000000000001';
const BRACKET_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

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

describe('strayOrders', () => {
  const sl = {
    coin: 'BTC',
    cloid: makeCloid(APP_PREFIX, BRACKET_ID, 'sl', 0),
    sz: 0,
    reduceOnly: true,
  };
  const bracket = { plan: { id: BRACKET_ID }, outcome: null };

  it('hides the orders of the running bracket', () => {
    expect(strayOrders([sl], bracket)).toEqual([]);
  });

  it('lists the stop an ended bracket left resting', () => {
    const ended = { ...bracket, outcome: { kind: 'cancelled', reason: 'dismissed' } } as const;
    expect(strayOrders([sl], ended)).toEqual([sl]);
  });
});

describe('daily lock', () => {
  async function connectWithBracket() {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal('sessionStorage', { removeItem: () => undefined });
    vi.stubGlobal('document', { addEventListener: () => undefined });
    vi.stubGlobal('window', { addEventListener: () => undefined });
    const choose = vi.fn();
    let show: (bracket: Bracket) => void = () => undefined;
    vi.mocked(createBracketManager).mockImplementation((deps) => {
      show = (bracket) => {
        deps.onChange({ bracket, lastError: null });
      };
      return {
        load: () => Promise.resolve(),
        reconcile: vi.fn(),
        choose,
      } as unknown as BracketManager;
    });
    vi.mocked(connectAgent).mockResolvedValue({
      ok: true,
      client: { master: MASTER } as unknown as ExecutionClient,
    });
    vi.mocked(subscribeAccount).mockResolvedValue(vi.fn());
    expect(await useExecutionStore().connect('0xkey', false)).toBe(true);
    const latch = () => {
      const lock = { reason: 'loss_limit', until: Date.now() + 3_600_000 } as const;
      useAccountStore().persistRules({ ...initialRulesState, lock });
    };
    return { choose, show, latch };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('cancels the resting entry when a lock latches mid-bracket', async () => {
    const { choose, show, latch } = await connectWithBracket();
    show(resting());
    latch();
    await nextTick();
    expect(choose).toHaveBeenCalledWith({ type: 'cancel_entry' });
  });

  it('cancels an entry that comes to rest after the lock latched', async () => {
    const { choose, show, latch } = await connectWithBracket();
    show(working());
    latch();
    await nextTick();
    expect(choose).not.toHaveBeenCalled();
    show(resting());
    await nextTick();
    expect(choose).toHaveBeenCalledWith({ type: 'cancel_entry' });
  });
});

describe('connect', () => {
  it('leaves nothing wired to the account when loading the saved bracket fails', async () => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal('sessionStorage', { removeItem: () => undefined });
    const reconcile = vi.fn();
    vi.mocked(createBracketManager).mockReturnValue({
      load: () => Promise.reject(new Error('storage blocked')),
      reconcile,
    } as unknown as BracketManager);
    vi.mocked(connectAgent).mockResolvedValue({
      ok: true,
      client: { master: MASTER } as unknown as ExecutionClient,
    });
    const closeFeed = vi.fn();
    let feed: Parameters<typeof subscribeAccount>[2] | undefined;
    vi.mocked(subscribeAccount).mockImplementation((_master, _coin, handlers) => {
      feed = handlers;
      return Promise.resolve(closeFeed);
    });

    const execution = useExecutionStore();
    expect(await execution.connect('0xkey', false)).toBe(false);
    feed?.onConnection(true);
    feed?.onPosition({ sz: 1, isLong: true, unrealizedPnl: 0, time: 0 });

    expect(closeFeed).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(useAccountStore().position).toBeNull();
    expect(useTerminalStore().network).toBe('mainnet');
    vi.unstubAllGlobals();
  });
});
