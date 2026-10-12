import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCloid } from '../core/bracket/cloid';
import type { DayStats } from '../core/rules';
import { loadOpenOrders } from '../hl/account';
import { loadDayStats } from '../services/accountData';
import { useAccountStore } from './account';
import { useTerminalStore } from './terminal';

vi.mock('../hl/account', () => ({
  loadFills: vi.fn(),
  loadFunding: vi.fn(),
  loadUnrealizedPnl: vi.fn(),
  loadProfile: vi.fn(() => Promise.resolve({ unified: false, fees: { taker: 0, maker: 0 } })),
  loadLimits: vi.fn(() =>
    Promise.resolve({
      equity: 1000,
      maxTradeSz: { long: 1, short: 1 },
      fees: { taker: 0, maker: 0 },
    }),
  ),
  loadOpenOrders: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../services/accountData', () => ({
  incrementalFills: vi.fn(() => ({})),
  loadDayStats: vi.fn(),
}));

const MASTER = '0x0000000000000000000000000000000000000001';
const BRACKET_ID = '000000000000000000000001';
const flatDay: DayStats = { trips: [], dayPnlUsd: 0 };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function openAccount() {
  const account = useAccountStore();
  await account.open(MASTER);
  return account;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('account store', () => {
  it('keeps the newer day stats when an older refresh lands last', async () => {
    const account = await openAccount();
    const older = deferred<DayStats>();
    const newer = deferred<DayStats>();
    vi.mocked(loadDayStats).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    vi.setSystemTime(1000);
    const first = account.refreshStats();
    vi.setSystemTime(2000);
    const second = account.refreshStats();
    newer.resolve({ trips: [], dayPnlUsd: -20 });
    await second;
    older.resolve(flatDay);
    await first;

    expect(account.stats).toMatchObject({ dayPnlUsd: -20, asOf: 2000 });
  });

  it('lists only the app orders on the coin, not the e2e script ones', async () => {
    const account = await openAccount();
    const app = makeCloid('7466', BRACKET_ID, 'entry', 0);
    const e2e = makeCloid('7465', BRACKET_ID, 'entry', 0);
    vi.mocked(loadDayStats).mockResolvedValue(flatDay);
    vi.mocked(loadOpenOrders).mockResolvedValueOnce(
      [app, e2e].map((cloid) => ({ coin: 'BTC', cloid, sz: 0.01, reduceOnly: false })),
    );

    account.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(account.appOrders.map((o) => o.cloid)).toEqual([app]);
  });

  it('drops a refresh that lands after the account was closed', async () => {
    const account = await openAccount();
    const day = deferred<DayStats>();
    vi.mocked(loadDayStats).mockReturnValueOnce(day.promise);

    account.refresh();
    await vi.advanceTimersByTimeAsync(300);
    account.close();
    day.resolve(flatDay);
    await vi.runOnlyPendingTimersAsync();

    expect(useTerminalStore().account).toBeNull();
    expect(account.stats.asOf).toBe(0);
  });

  it('hands sizing the budget left after every stats read', async () => {
    const account = await openAccount();
    vi.mocked(loadDayStats).mockResolvedValue(flatDay);
    account.setRules({ lossLimit: { usd: 100, hard: true } });
    account.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(useTerminalStore().account?.budgetRemainingUsd).toBe(100);

    vi.mocked(loadDayStats).mockResolvedValue({ trips: [], dayPnlUsd: -60 });
    await account.refreshStats();
    expect(useTerminalStore().account?.budgetRemainingUsd).toBe(40);
  });

  it("never writes one master's day stats into the next one", async () => {
    const account = await openAccount();
    const day = deferred<DayStats>();
    vi.mocked(loadDayStats).mockReturnValueOnce(day.promise);

    vi.setSystemTime(1000);
    const late = account.refreshStats();
    await account.open('0x0000000000000000000000000000000000000002');
    day.resolve({ trips: [], dayPnlUsd: -500 });
    await late;

    expect(account.stats).toMatchObject({ dayPnlUsd: 0, asOf: 0 });
  });
});
