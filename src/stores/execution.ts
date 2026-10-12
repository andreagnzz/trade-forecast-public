import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { exitIsBuy, isUnprotected, phase, type BracketPlan } from '../core/bracket/bracket';
import { makeCloid, parseCloid, type Cloid } from '../core/bracket/cloid';
import type { Rules } from '../core/rules';
import { loadFills, loadOpenOrders, loadPosition, subscribeAccount } from '../hl/account';
import { connectAgent, type ExecutionClient } from '../hl/exchange';
import { exitPx, snapPrice } from '../hl/format';
import {
  createBracketManager,
  randomBracketId,
  type BracketManager,
  type BracketView,
  type SendRefusal,
} from '../services/bracketManager';
import { createOrderService, type OrderService } from '../services/orderService';
import { useAccountStore } from './account';
import { MAX_SLIPPAGE, MIN_NOTIONAL_USD, useTerminalStore } from './terminal';

const KEY_STORAGE = 'tf.agentKey';

const KEY_ERRORS = {
  malformed_key: 'Malformed key: 0x followed by 64 hex characters.',
  not_agent: 'Not an agent key. Create an API wallet on the testnet app and paste its key.',
} as const;

const REFUSALS: Record<SendRefusal, string> = {
  bracket_active: 'not sent: bracket running',
  coin_busy: 'not sent: position or orders on this coin (one net position per coin)',
  blocked: 'not sent: locked until 00:00 UTC',
  stop_crossed: 'not sent: stop already through mark',
  stats_unavailable: 'not sent: day stats unavailable',
};

// Kept out of Pinia state: the client closes over the signing key and devtools must never see
// it. Only the master address and plain data reach the stores.
let orders: OrderService | null = null;
let manager: BracketManager | null = null;

export const useExecutionStore = defineStore('execution', () => {
  const terminal = useTerminalStore();
  const account = useAccountStore();
  const connecting = ref(false);
  const keyError = ref<string | null>(null);
  const view = shallowRef<BracketView>({ bracket: null, lastError: null });
  const notice = ref<string | null>(null);
  const accountFeed = ref<'connecting' | 'open' | 'closed'>('connecting');

  const bracket = computed(() => view.value.bracket);
  const active = computed(() => !!bracket.value && !bracket.value.outcome);
  const bracketPhase = computed(() => (bracket.value ? phase(bracket.value) : null));
  const unprotected = computed(() => !!bracket.value && isUnprotected(bracket.value));
  // App orders on the coin that belong to no running bracket.
  const strayOrders = computed(() =>
    account.appOrders.filter((o) => parseCloid(o.cloid)?.bracketId !== bracket.value?.plan.id),
  );
  // Exposure on the coin that no local bracket tracks: cleared storage or another browser.
  const stray = computed(
    () => !active.value && ((account.position?.size ?? 0) > 0 || strayOrders.value.length > 0),
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

  function createManager(connected: ExecutionClient, gate: OrderService) {
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
          window.setTimeout(run, ms);
        },
      },
      onChange: (next) => {
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
    terminal.useNetwork('testnet');
    await account.open(connected.master);
    orders = createOrderService({
      client: connected,
      rules: { load: () => account.rulesState, save: account.persistRules },
      stats: account.refreshStats,
      now: Date.now,
    });
    const service = createManager(connected, orders);
    manager = service;
    await subscribeAccount(connected.master, terminal.coin, {
      onOrder: service.onOrderUpdate,
      onFills: (fills) => {
        service.onFills(fills);
        account.refresh();
      },
      onPosition: (next) => {
        account.position = next;
      },
      onConnection: (open) => {
        accountFeed.value = open ? 'open' : 'closed';
        if (open) void service.reconcile();
      },
    });
    watchTab(service);
    await service.load();
    account.refresh();
  }

  async function connect(key: string, remember: boolean) {
    connecting.value = true;
    keyError.value = null;
    try {
      const connection = await connectAgent(key.trim());
      if (!connection.ok) {
        keyError.value = KEY_ERRORS[connection.error];
        return;
      }
      if (remember) sessionStorage.setItem(KEY_STORAGE, key.trim());
      else sessionStorage.removeItem(KEY_STORAGE);
      await start(connection.client);
    } catch (error) {
      keyError.value = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
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
      prefix: '7466',
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

  async function closeStray() {
    const position = account.position;
    if (!orders || !position || position.size === 0) return;
    const isBuy = !position.isLong;
    const px = marketExitPx(isBuy);
    if (!px) return;
    await orders.send(terminal.coin, {
      type: 'place',
      cloid: makeCloid('7466', randomBracketId(), 'close', 0),
      order: { isBuy, px, size: position.size, reduceOnly: true, type: 'ioc' },
    });
    account.refresh();
  }

  async function cancelStray(cloid: Cloid) {
    if (!orders) return;
    await orders.send(terminal.coin, { type: 'cancel', cloid });
    account.refresh();
  }

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
    strayOrders,
    stray,
    blocker,
    canSend,
    notice,
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
