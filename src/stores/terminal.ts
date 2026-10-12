import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { sizePosition, type SizingInput, type SizingResult } from '../core/sizing';
import type { AccountLimits } from '../hl/account';
import { snapPrice, snapSize } from '../hl/format';
import {
  loadCandles,
  loadInstrument,
  loadQuote,
  subscribeMarket,
  type Candle,
  type Instrument,
  type Network,
  type Quote,
} from '../hl/marketData';

type Side = SizingInput['side'];
type EntryKind = SizingInput['entry']['kind'];
type Risk = SizingInput['risk'];
export type Leg = 'entry' | 'stop' | 'tp';

type LiveAccount = AccountLimits & { budgetRemainingUsd?: number };

const COIN = 'BTC';
// Hyperliquid base tier (docs, "Fees"): 0.045% taker, 0.015% maker.
const FEES = { taker: 0.00045, maker: 0.00015 };
export const MAX_SLIPPAGE = 0.002;
export const STOP_SLIPPAGE_BUFFER = 0.001;
export const MIN_NOTIONAL_USD = 10;
const DEFAULT_STOP_DISTANCE = 0.005;
const DEFAULT_TP_DISTANCE = 0.015;

export const useTerminalStore = defineStore('terminal', () => {
  const network = ref<Network>('mainnet');
  // Live mode sizes on the testnet account; Preview keeps the hypothetical equity and base fees.
  const account = shallowRef<LiveAccount | null>(null);
  const status = ref<'loading' | 'ready' | 'error'>('loading');
  const connection = ref<'connecting' | 'open' | 'closed'>('connecting');
  const instrument = ref<Instrument>();
  const quote = ref<Quote>();
  const markPx = ref(0);
  const cursorPx = ref<number>();
  const candles = shallowRef<Candle[]>([]);
  const lastCandle = shallowRef<Candle>();

  const side = ref<Side>('long');
  const entryKind = ref<EntryKind>('market');
  const limitPx = ref(0);
  const stopPx = ref(0);
  const tpPx = ref(0);
  const risk = ref<Risk>({ kind: 'pct_equity', value: 0.5 });
  const equity = ref(10_000);
  const sizingEquity = computed(() => account.value?.equity ?? equity.value);

  const dir = computed(() => (side.value === 'long' ? 1 : -1));
  const marketRefPx = computed(() => {
    if (!quote.value) return 0;
    return side.value === 'long' ? quote.value.ask : quote.value.bid;
  });
  const expectedEntryPx = computed(() =>
    entryKind.value === 'market' ? marketRefPx.value : limitPx.value,
  );

  // Judged on the snapped price: a raw drag one tick past the touch still truncates onto it.
  const limitCrosses = computed(() => {
    const spec = instrument.value;
    if (!spec || entryKind.value !== 'limit') return false;
    return dir.value * (snapPrice(limitPx.value, spec.szDecimals) - marketRefPx.value) >= 0;
  });

  const sizing = computed<SizingResult | undefined>(() => {
    const spec = instrument.value;
    // Reads marketRefPx rather than quote: a bbo tick that leaves the touch unchanged
    // does not recompute.
    if (!spec || !(marketRefPx.value > 0)) return undefined;
    return sizePosition({
      side: side.value,
      entry:
        entryKind.value === 'market'
          ? { kind: 'market', refPx: marketRefPx.value, maxSlippage: MAX_SLIPPAGE }
          : { kind: 'limit', px: limitPx.value, marketable: limitCrosses.value },
      stopPx: stopPx.value,
      tpPx: tpPx.value,
      risk: risk.value,
      equity: sizingEquity.value,
      budgetRemainingUsd: account.value?.budgetRemainingUsd,
      maxTradeSz: account.value?.maxTradeSz[side.value],
      stopSlippageBuffer: STOP_SLIPPAGE_BUFFER,
      spec: { ...spec, minNotionalUsd: MIN_NOTIONAL_USD },
      fees: account.value?.fees ?? FEES,
      snapPrice: (px) => snapPrice(px, spec.szDecimals),
      snapSize: (sz) => snapSize(sz, spec.szDecimals),
    });
  });

  const okSizing = computed(() => (sizing.value?.ok ? sizing.value.value : undefined));

  // Every line write goes through here, snapped, so a sub-tick drag writes the same value
  // and triggers nothing.
  function setLine(leg: Leg, rawPx: number) {
    const spec = instrument.value;
    if (!spec) return;
    const px = snapPrice(rawPx, spec.szDecimals);
    if (px === 0) return;
    if (leg === 'stop') stopPx.value = px;
    if (leg === 'tp') tpPx.value = px;
    if (leg === 'entry') limitPx.value = px;
  }

  function reset() {
    const px = marketRefPx.value;
    entryKind.value = 'market';
    setLine('stop', px * (1 - dir.value * DEFAULT_STOP_DISTANCE));
    setLine('tp', px * (1 + dir.value * DEFAULT_TP_DISTANCE));
  }

  function moveLine(leg: Leg, rawPx: number) {
    if (leg === 'entry') entryKind.value = 'limit';
    setLine(leg, rawPx);
  }

  // A limit starts at the passive touch, so it rests as maker.
  function moveLimitToPassiveTouch() {
    if (!quote.value) return;
    limitPx.value = side.value === 'long' ? quote.value.bid : quote.value.ask;
  }

  // Mirror stop and take-profit around the entry so the new side keeps valid geometry.
  function setSide(next: Side) {
    if (side.value === next) return;
    const entryPx = expectedEntryPx.value;
    side.value = next;
    if (entryKind.value === 'limit') moveLimitToPassiveTouch();
    setLine('stop', 2 * entryPx - stopPx.value);
    setLine('tp', 2 * entryPx - tpPx.value);
  }

  function setEntryKind(next: EntryKind) {
    if (entryKind.value === next) return;
    if (next === 'limit') moveLimitToPassiveTouch();
    entryKind.value = next;
  }

  // Without a usable equity there is nothing to convert through: keep the number.
  function setRiskKind(kind: Risk['kind']) {
    const { value } = risk.value;
    if (risk.value.kind === kind) return;
    const base = sizingEquity.value;
    if (!(Number.isFinite(base) && base > 0)) {
      risk.value = { kind, value };
      return;
    }
    const converted = kind === 'usd' ? (base * value) / 100 : (value / base) * 100;
    risk.value = { kind, value: Number(converted.toFixed(2)) };
  }

  // Each start owns the feed until the next one: events from a closed network are dropped, so
  // mainnet preview prices can never size a testnet order.
  let generation = 0;
  let closeFeed: () => void = () => undefined;

  async function start() {
    const current = ++generation;
    const live = () => current === generation;
    closeFeed();
    status.value = 'loading';
    connection.value = 'connecting';
    // Nothing from the previous network may size anything while the new one loads.
    instrument.value = undefined;
    quote.value = undefined;
    markPx.value = 0;
    try {
      const [spec, history, book] = await Promise.all([
        loadInstrument(COIN, network.value),
        loadCandles(COIN, network.value),
        loadQuote(COIN, network.value),
      ]);
      if (!live()) return;
      instrument.value = spec;
      markPx.value = spec.markPx;
      candles.value = history;
      quote.value = book;
      reset();
      status.value = 'ready';
    } catch {
      if (live()) status.value = 'error';
      return;
    }
    // The REST seed is already on screen: a failed subscription only means no live updates.
    try {
      const close = await subscribeMarket(COIN, network.value, {
        onCandle: (candle) => {
          if (live()) lastCandle.value = candle;
        },
        onQuote: (next) => {
          if (live()) quote.value = next;
        },
        onMark: (px) => {
          if (live()) markPx.value = px;
        },
        onConnection: (isOpen) => {
          if (live()) connection.value = isOpen ? 'open' : 'closed';
        },
      });
      if (live()) closeFeed = close;
      else close();
    } catch {
      if (live()) connection.value = 'closed';
    }
  }

  function useNetwork(next: Network) {
    if (network.value === next) return;
    network.value = next;
    void start();
  }

  return {
    coin: COIN,
    network,
    account,
    quote,
    useNetwork,
    status,
    connection,
    markPx,
    cursorPx,
    candles,
    lastCandle,
    side,
    entryKind,
    stopPx,
    tpPx,
    risk,
    equity,
    instrument,
    expectedEntryPx,
    limitCrosses,
    sizing,
    okSizing,
    reset,
    moveLine,
    setSide,
    setEntryKind,
    setRiskKind,
    start,
  };
});
