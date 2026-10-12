import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { subscribeAccount } from '../hl/account';
import { connectAgent, type ExecutionClient } from '../hl/exchange';
import { createBracketManager, type BracketManager } from '../services/bracketManager';
import type { SendResult } from '../services/orderService';
import { useAccountStore } from './account';
import { strayNotice, useExecutionStore } from './execution';
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
