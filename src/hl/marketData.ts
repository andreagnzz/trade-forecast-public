import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from '@nktkas/hyperliquid';
import { parseNumber } from './format';

export interface Candle {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Instrument {
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
}

export interface Quote {
  bid: number;
  ask: number;
}

interface MarketHandlers {
  onCandle: (candle: Candle) => void;
  onQuote: (quote: Quote) => void;
  onMark: (markPx: number) => void;
  onConnection: (connected: boolean) => void;
}

const CANDLE_INTERVAL = '1m';
const CANDLE_COUNT = 500;

export type Network = 'mainnet' | 'testnet';

// Read-only market data. Preview reads mainnet; Live and the e2e script read testnet, the
// network orders go to. These transports never get an ExchangeClient.
const infos: Record<Network, InfoClient> = {
  mainnet: new InfoClient({ transport: new HttpTransport({ isTestnet: false }) }),
  testnet: new InfoClient({ transport: new HttpTransport({ isTestnet: true }) }),
};

const toCandle = (c: { t: number; o: string; h: string; l: string; c: string }): Candle => ({
  timeMs: c.t,
  open: parseNumber(c.o),
  high: parseNumber(c.h),
  low: parseNumber(c.l),
  close: parseNumber(c.c),
});

export async function loadInstrument(coin: string, network: Network): Promise<Instrument> {
  const [meta, ctxs] = await infos[network].metaAndAssetCtxs();
  const index = meta.universe.findIndex((asset) => asset.name === coin);
  const asset = meta.universe[index];
  const ctx = ctxs[index];
  if (!asset || !ctx) throw new Error(`unknown coin: ${coin}`);
  return {
    szDecimals: asset.szDecimals,
    maxLeverage: asset.maxLeverage,
    markPx: parseNumber(ctx.markPx),
  };
}

export async function loadCandles(coin: string, network: Network): Promise<Candle[]> {
  const startTime = Date.now() - CANDLE_COUNT * 60_000;
  const candles = await infos[network].candleSnapshot({
    coin,
    interval: CANDLE_INTERVAL,
    startTime,
  });
  return candles.map(toCandle);
}

export async function loadQuote(coin: string, network: Network): Promise<Quote> {
  const book = await infos[network].l2Book({ coin });
  const bid = book?.levels[0][0];
  const ask = book?.levels[1][0];
  if (!bid || !ask) throw new Error(`empty book: ${coin}`);
  return { bid: parseNumber(bid.px), ask: parseNumber(ask.px) };
}

export async function loadAsks(coin: string, network: Network, depth: number) {
  const book = await infos[network].l2Book({ coin });
  return (book?.levels[1] ?? [])
    .slice(0, depth)
    .map((l) => ({ px: parseNumber(l.px), sz: parseNumber(l.sz) }));
}

// The SDK socket reconnects and resubscribes on its own; we only surface its state. The
// returned close stops a network's feed when the terminal switches to the other one. A failed
// subscribe closes the socket here, so no handler outlives the error.
export async function subscribeMarket(
  coin: string,
  network: Network,
  handlers: MarketHandlers,
): Promise<() => void> {
  const transport = new WebSocketTransport({ isTestnet: network === 'testnet' });
  transport.socket.addEventListener('open', () => {
    handlers.onConnection(true);
  });
  transport.socket.addEventListener('close', () => {
    handlers.onConnection(false);
  });
  const subscriptions = new SubscriptionClient({ transport });
  try {
    await Promise.all([
      subscriptions.candle({ coin, interval: CANDLE_INTERVAL }, (event) => {
        handlers.onCandle(toCandle(event));
      }),
      subscriptions.bbo({ coin }, ({ bbo: [bid, ask] }) => {
        if (bid && ask) handlers.onQuote({ bid: parseNumber(bid.px), ask: parseNumber(ask.px) });
      }),
      subscriptions.activeAssetCtx({ coin }, ({ ctx }) => {
        handlers.onMark(parseNumber(ctx.markPx));
      }),
    ]);
  } catch (error) {
    transport.close();
    throw error;
  }
  handlers.onConnection(true);
  return () => {
    transport.close();
  };
}
