import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { parseCloid, type Cloid } from '../core/bracket/cloid';
import { budgetRemainingUsd, utcDayStart } from '../core/budget';
import {
  changeRules,
  initialRulesState,
  resolveRules,
  updateLock,
  type DayStats,
  type Rules,
  type RulesState,
} from '../core/rules';
import {
  loadFills,
  loadFunding,
  loadLimits,
  loadOpenOrders,
  loadProfile,
  loadUnrealizedPnl,
  type Address,
  type AccountLimits,
  type AccountOrder,
  type Position,
} from '../hl/account';
import { incrementalFills, loadDayStats } from '../services/accountData';
import { loadRules, saveRules } from './rulesStorage';
import { useTerminalStore } from './terminal';

type Profile = Awaited<ReturnType<typeof loadProfile>>;

const REFRESH_DELAY_MS = 300;
const CLOCK_TICK_MS = 30_000;

// What the testnet account looks like: day stats and rules, size limits, position and the
// app's orders on the coin. Bracket execution lives in the execution store.
export const useAccountStore = defineStore('account', () => {
  const terminal = useTerminalStore();
  const master = ref<Address | null>(null);
  const rulesState = ref<RulesState>(initialRulesState);
  // asOf says when the stats were read, so a lock is never latched on yesterday's numbers.
  const noStats = { trips: [], dayPnlUsd: 0, asOf: 0 };
  const stats = shallowRef<DayStats & { asOf: number }>(noStats);
  const limits = shallowRef<AccountLimits | null>(null);
  const position = shallowRef<Position | null>(null);
  const appOrders = shallowRef<(AccountOrder & { cloid: Cloid })[]>([]);
  const syncError = ref<string | null>(null);
  let profile: Profile | null = null;
  let recentFills: ReturnType<typeof incrementalFills> | null = null;

  // A lock ends at 00:00 UTC whether or not anything else happens.
  const now = ref(Date.now());
  setInterval(() => {
    now.value = Date.now();
  }, CLOCK_TICK_MS);
  const rules = computed(() => resolveRules(rulesState.value, now.value));

  function persistRules(state: RulesState) {
    rulesState.value = state;
    if (master.value) saveRules(master.value, state);
  }

  async function refreshStats(): Promise<DayStats> {
    const address = master.value;
    if (!address || !recentFills) return stats.value;
    const now = Date.now();
    const day = await loadDayStats(
      {
        fills: recentFills,
        funding: (since) => loadFunding(address, since),
        unrealizedPnl: () => loadUnrealizedPnl(address),
      },
      now,
    );
    // Refreshes overlap: one started earlier, or for an account since closed, may answer later.
    if (address !== master.value || now < stats.value.asOf) return stats.value;
    stats.value = { ...day, asOf: now };
    // The lock latches on every refresh, not only before orders.
    persistRules(updateLock(rulesState.value, stats.value, now));
    return stats.value;
  }

  const budgetLeftUsd = computed(() => {
    const limit = rules.value.rules.lossLimit;
    return limit ? budgetRemainingUsd(limit.usd, stats.value.dayPnlUsd) : undefined;
  });
  const softLimitReached = computed(
    () => rules.value.rules.lossLimit?.hard === false && budgetLeftUsd.value === 0,
  );

  // Live sizing reads the account limits. Only a hard limit caps the size at what is left of
  // today's budget; a soft one only warns.
  function pushAccount() {
    if (!limits.value) return;
    terminal.account = {
      ...limits.value,
      budgetRemainingUsd: rules.value.rules.lossLimit?.hard ? budgetLeftUsd.value : undefined,
    };
  }

  // The position itself arrives on the socket; this reads what the socket does not push.
  async function refreshAccount() {
    const address = master.value;
    if (!address || !profile) return;
    const [, nextLimits, open] = await Promise.all([
      refreshStats(),
      loadLimits(address, terminal.coin, profile),
      loadOpenOrders(address),
    ]);
    if (address !== master.value) return;
    limits.value = nextLimits;
    pushAccount();
    // The e2e script's orders (its own prefix) are not the app's to close or cancel.
    appOrders.value = open.filter(
      (o): o is AccountOrder & { cloid: Cloid } =>
        o.coin === terminal.coin && o.cloid !== null && parseCloid(o.cloid)?.prefix === '7466',
    );
    syncError.value = null;
  }

  // Fills, the bracket's end and stray actions all ask for a refresh, often within
  // milliseconds: requests are gathered for a moment, one runs at a time, and one more follows
  // if asked for meanwhile.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  let refreshAgain = false;
  function runRefresh() {
    refreshTimer = null;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    refreshAccount()
      .catch(() => {
        syncError.value = 'account refresh failed, retrying on next update';
      })
      .finally(() => {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      });
  }
  function refresh() {
    refreshTimer ??= setTimeout(runRefresh, REFRESH_DELAY_MS);
  }

  async function open(address: Address) {
    master.value = address;
    stats.value = noStats;
    recentFills = incrementalFills((since) => loadFills(address, since));
    rulesState.value = loadRules(address);
    profile = await loadProfile(address);
  }

  function close() {
    master.value = null;
    position.value = null;
    appOrders.value = [];
    limits.value = null;
    terminal.account = null;
  }

  // Returns false when the patch is invalid.
  function setRules(patch: Partial<Rules>): boolean {
    const now = Date.now();
    const changed = changeRules(rulesState.value, patch, now);
    if (!changed.ok) return false;
    // A rule armed after today's loss locks now; stats from before 00:00 UTC wait for a refresh.
    const today = stats.value.asOf >= utcDayStart(now);
    persistRules(today ? updateLock(changed.state, stats.value, now) : changed.state);
    pushAccount();
    return true;
  }

  return {
    master,
    rulesState,
    rules,
    stats,
    budgetLeftUsd,
    softLimitReached,
    position,
    appOrders,
    syncError,
    persistRules,
    refreshStats,
    refresh,
    open,
    close,
    setRules,
  };
});
