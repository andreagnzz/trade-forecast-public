import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { exitIsBuy, isUnprotected, phase, type BracketPlan } from '../core/bracket/bracket';
import { APP_PREFIX, makeCloid, parseCloid, type Cloid } from '../core/bracket/cloid';
import type { Rules } from '../core/rules';
import { loadFills, loadOpenOrders, loadPosition, subscribeAccount } from '../hl/account';
import { connectAgent, type ExecutionClient } from '../hl/exchange';
import { errorText, messageOf } from '../hl/errors';
import { exitPx, MIN_NOTIONAL_USD, snapPrice } from '../hl/format';
import {
  createBracketManager,
  randomBracketId,
  type BracketManager,
  type BracketView,
  type SendRefusal,
} from '../services/bracketManager';
import { createOrderService, type OrderService, type SendResult } from '../services/orderService';
import { useAccountStore } from './account';
import { MAX_SLIPPAGE, useTerminalStore } from './terminal';

const KEY_STORAGE = 'tf.agentKey';

const KEY_ERRORS = {
  malformed_key: 'Malformed key: 0x followed by 64 hex characters.',
  not_agent: 'Not an agent key. Create an API wallet on the testnet app and paste its key.',
} as const;

const REFUSALS: Record<SendRefusal, string> = {
  bracket_active: 'not sent: bracket running',
  coin_busy: 'not sent: position or orders on this coin (one net position per coin)',
  blocked: 'not sent: locked until 00:00 UTC',
  no_mark: 'not sent: no mark price',
  stop_crossed: 'not sent: stop already through mark',
  stats_unavailable: 'not sent: day stats unavailable',
};

// App orders on the coin that belong to no running bracket, such as the stop a dismissed one
// leaves resting.
export function strayOrders<O extends { cloid: Cloid }>(
  orders: readonly O[],
  bracket: { plan: { id: string }; outcome: unknown } | null,
): O[] {
  const running = bracket && !bracket.outcome ? bracket.plan.id : null;
  return orders.filter((o) => parseCloid(o.cloid)?.bracketId !== running);
}

// Stray actions are reduce-only or cancels: the gate never blocks them.
export function strayNotice(result: SendResult): string | null {
  if (result.status === 'rejected') return errorText(result.error);
  if (result.status === 'uncertain') return 'uncertain: check open orders';
  return null;
}

// Kept out of Pinia state: the client closes over the signing key and devtools must never see
// it. Only the master address and plain data reach the stores.
let orders: OrderService | null = null;
let manager: BracketManager | null = null;
let closeAccountFeed: () => void = () => undefined;
// Each start owns the account feed until it is rolled back: a dead session's socket events,
// timers and bracket updates are dropped, so its manager can never act again.
let session = 0;

export const useExecutionStore = defineStore('execution', () => {
  const terminal = useTerminalStore();
  const account = useAccountStore();
  const connecting = ref(false);
  const keyError = ref<string | null>(null);
  const view = shallowRef<BracketView>({ bracket: null, lastError: null });
  const notice = ref<string | null>(null);
  const strayBusy = ref(false);
  const accountFeed = ref<'connecting' | 'open' | 'closed'>('connecting');

  const bracket = computed(() => view.value.bracket);
  const active = computed(() => !!bracket.value && !bracket.value.outcome);
  const bracketPhase = computed(() => (bracket.value ? phase(bracket.value) : null));
  const unprotected = computed(() => !!bracket.value && isUnprotected(bracket.value));
  const strays = computed(() => strayOrders(account.appOrders, bracket.value));
  // Exposure on the coin that no local bracket tracks: cleared storage or another browser.
  const stray = computed(
    () => !active.value && ((account.position?.sz ?? 0) > 0 || strays.value.length > 0),
  );
  // A resting entry would add exposure after the lock: stop working it. A no-op unless it rests.
  watch(
    () => account.rules.lock !== null,
    (locked) => {
      if (locked) manager?.choose({ type: 'cancel_entry' });
    },
  );
  // The panel only mirrors these gates; OrderService and BracketManager enforce them again.
  const blocker = computed(() => {
    if (account.rules.lock) return 'Locked until 00:00 UTC';
    if (active.value) return 'Bracket running';
    if (stray.value) return 'Coin busy';
    // With the socket down, quote and mark are stale: sizing and the crossed-stop check too.
    if (terminal.connection !== 'open') return 'Market data disconnected';
    return null;
  });
  // Live sizing needs the account's equity, caps and fees: never the Preview defaults.
  const canSend = computed(
    () =>
      !!account.master &&
      !!terminal.account &&
      terminal.okSizing?.status === 'ok' &&
      blocker.value === null,
  );

  function createManager(connected: ExecutionClient, gate: OrderService, live: () => boolean) {
    return createBracketManager({
      orders: gate,
      client: connected,
      reads: {
        openOrders: () => loadOpenOrders(connected.master),
        fills: (since) => loadFills(connected.master, since),
        position: (coin) => loadPosition(connected.master, coin),
      },
      storage: localStorage,
      storageKey: `tf.bracket.${connected.master}`,
      clock: {
        setTimeout: (run, ms) => {
          window.setTimeout(() => {
            if (live()) run();
          }, ms);
        },
      },
      onChange: (next) => {
        if (!live()) return;
        const ended = !!next.bracket?.outcome && !view.value.bracket?.outcome;
        view.value = next;
        if (ended) account.refresh();
      },
    });
  }

  function watchTab(service: BracketManager) {
    // A tab coming back may have missed fills: the exchange is the source of truth.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void service.reconcile();
    });
    // A resting limit entry only gets its take-profit placed or resized while a tab is open.
    window.addEventListener('beforeunload', (event) => {
      const b = view.value.bracket;
      if (b && !b.outcome && b.entry.status === 'live' && b.plan.entry.type !== 'ioc') {
        event.preventDefault();
      }
    });
  }

  async function start(connected: ExecutionClient) {
    const current = ++session;
    const live = () => current === session;
    terminal.useNetwork('testnet');
    await account.open(connected.master);
    orders = createOrderService({
      client: connected,
      rules: { load: () => account.rulesState, save: account.persistRules },
      stats: account.refreshStats,
      now: Date.now,
    });
    const service = createManager(connected, orders, live);
    manager = service;
    closeAccountFeed = await subscribeAccount(connected.master, terminal.coin, {
      onOrder: (update) => {
        if (live()) service.onOrderUpdate(update);
      },
      onFills: (fills) => {
        if (!live()) return;
        service.onFills(fills);
        account.onFills(fills);
      },
      onPosition: (next) => {
        if (live()) account.position = next;
      },
      onConnection: (open) => {
        if (!live()) return;
        accountFeed.value = open ? 'open' : 'closed';
        if (open) void service.reconcile();
      },
    });
    await service.load();
    watchTab(service);
    account.refresh();
  }

  // A start that fails halfway must not leave a master, a bracket manager or the testnet badge
  // behind: the terminal goes back to Preview.
  function rollBack() {
    session += 1;
    closeAccountFeed();
    orders = null;
    manager = null;
    account.close();
    view.value = { bracket: null, lastError: null };
    accountFeed.value = 'connecting';
    terminal.useNetwork('mainnet');
  }

  // Returns true once the terminal is live on testnet.
  async function connect(key: string, remember: boolean): Promise<boolean> {
    connecting.value = true;
    keyError.value = null;
    try {
      const connection = await connectAgent(key.trim());
      if (!connection.ok) {
        keyError.value = KEY_ERRORS[connection.error];
        return false;
      }
      if (remember) sessionStorage.setItem(KEY_STORAGE, key.trim());
      else sessionStorage.removeItem(KEY_STORAGE);
      await start(connection.client);
      return true;
    } catch (error) {
      rollBack();
      keyError.value = `connect failed: ${messageOf(error)}`;
      return false;
    } finally {
      connecting.value = false;
    }
  }

  // Only when the trader opted in to "remember for this tab".
  function resume() {
    const key = sessionStorage.getItem(KEY_STORAGE);
    if (key) void connect(key, true);
  }

  // Only testnet prices, fully loaded, ever size a testnet order.
  async function send() {
    const sizing = terminal.okSizing;
    const spec = terminal.instrument;
    const live = terminal.network === 'testnet' && terminal.status === 'ready';
    if (!manager || !live || !canSend.value || !sizing || !spec) return;
    const plan: BracketPlan = {
      id: randomBracketId(),
      prefix: APP_PREFIX,
      coin: terminal.coin,
      side: terminal.side,
      entry:
        terminal.entryKind === 'market'
          ? { type: 'ioc', px: sizing.entryPx }
          : { type: terminal.limitCrosses ? 'gtc' : 'alo', px: sizing.entryPx },
      size: sizing.size,
      szDecimals: spec.szDecimals,
      minNotionalUsd: MIN_NOTIONAL_USD,
      stopPx: sizing.stopPx,
      tpPx: sizing.tpPx ?? null,
      riskUsd: sizing.riskUsd,
    };
    try {
      const refusal = await manager.send(plan, terminal.markPx);
      notice.value = refusal ? REFUSALS[refusal] : null;
    } catch {
      notice.value = 'not sent: testnet unreachable';
    }
  }

  // Market exits cross by the same slippage cap as market entries.
  const marketExitPx = (isBuy: boolean) =>
    terminal.quote && terminal.instrument
      ? exitPx(terminal.quote, isBuy, MAX_SLIPPAGE, terminal.instrument.szDecimals)
      : null;

  function closeAtMarket() {
    const px = bracket.value && marketExitPx(exitIsBuy(bracket.value));
    if (px) manager?.choose({ type: 'close', px });
  }

  // A maker exit rests at the touch on its own side.
  function restAtBestMaker() {
    const { quote, instrument } = terminal;
    if (!bracket.value || !quote || !instrument) return;
    const touch = exitIsBuy(bracket.value) ? quote.bid : quote.ask;
    manager?.choose({ type: 'tp_at', px: snapPrice(touch, instrument.szDecimals) });
  }

  async function runStray(command: Parameters<OrderService['send']>[1]) {
    if (!orders) return;
    strayBusy.value = true;
    try {
      notice.value = strayNotice(await orders.send(terminal.coin, command));
    } catch {
      notice.value = 'not sent: testnet unreachable';
    } finally {
      strayBusy.value = false;
    }
    account.refresh();
  }

  async function closeStray() {
    const position = account.position;
    if (!position || position.sz === 0) return;
    const isBuy = !position.isLong;
    const px = marketExitPx(isBuy);
    if (!px) return;
    await runStray({
      type: 'place',
      cloid: makeCloid(APP_PREFIX, randomBracketId(), 'close', 0),
      order: { isBuy, px, size: position.sz, reduceOnly: true, type: 'ioc' },
    });
  }

  const cancelStray = (cloid: Cloid) => runStray({ type: 'cancel', cloid });

  function setRules(patch: Partial<Rules>) {
    notice.value = account.setRules(patch) ? null : 'rejected: loss limit must be positive';
  }

  return {
    connecting,
    keyError,
    view,
    bracket,
    active,
    bracketPhase,
    unprotected,
    strayOrders: strays,
    stray,
    blocker,
    canSend,
    notice,
    strayBusy,
    accountFeed,
    connect,
    resume,
    send,
    closeAtMarket,
    restAtBestMaker,
    closeStray,
    cancelStray,
    setRules,
    cancelEntry: () => manager?.choose({ type: 'cancel_entry' }),
    keepStopOnly: () => manager?.choose({ type: 'sl_only' }),
    dismiss: () => manager?.dismiss(),
  };
});
