import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayStats } from '../core/rules';
import { loadDayStats } from '../services/accountData';
import { useAccountStore } from './account';

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
});
