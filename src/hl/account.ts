import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from '@nktkas/hyperliquid';
import { isCloid, type Cloid } from '../core/bracket/cloid';
import type { Fill } from '../core/budget';
import { parseNumber } from './format';

// Read-only user data, on the same network as execution.
const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

export type Address = `0x${string}`;

export interface AccountFill extends Fill {
  cloid: string | null;
  px: number;
}

export interface AccountOrder {
  coin: string;
  cloid: Cloid | null;
  size: number;
  reduceOnly: boolean;
}

export interface Position {
  size: number;
  isLong: boolean;
  unrealizedPnl: number;
  time: number;
}

export interface AccountLimits {
  equity: number;
  maxTradeSz: { long: number; short: number };
  fees: { taker: number; maker: number };
}

interface WireFill {
  tid: number;
  px: string;
  coin: string;
  time: number;
  side: 'B' | 'A';
  sz: string;
  startPosition: string;
  closedPnl: string;
  fee: string;
  cloid?: string;
}

const toFill = (f: WireFill): AccountFill => ({
  tid: f.tid,
  coin: f.coin,
  time: f.time,
  side: f.side === 'B' ? 'buy' : 'sell',
  sz: parseNumber(f.sz),
  px: parseNumber(f.px),
  startPosition: parseNumber(f.startPosition),
  closedPnl: parseNumber(f.closedPnl),
  fee: parseNumber(f.fee),
  cloid: f.cloid ?? null,
});

function toPosition(
  state: {
    time: number;
    assetPositions: { position: { coin: string; szi: string; unrealizedPnl: string } }[];
  },
  coin: string,
): Position {
  const position = state.assetPositions.find((p) => p.position.coin === coin)?.position;
  const szi = parseNumber(position?.szi ?? '0');
  return {
    size: Math.abs(szi),
    isLong: szi > 0,
    unrealizedPnl: parseNumber(position?.unrealizedPnl ?? '0'),
    time: state.time,
  };
}

export async function loadOpenOrders(master: Address): Promise<AccountOrder[]> {
  const orders = await info.frontendOpenOrders({ user: master });
  return orders.map((o) => ({
    coin: o.coin,
    cloid: o.cloid && isCloid(o.cloid) ? o.cloid : null,
    size: parseNumber(o.sz),
    reduceOnly: o.reduceOnly,
  }));
}

const FILLS_PER_PAGE = 2000;

// At most 2,000 fills per answer: page forward from the last time seen. A fill at that time
// comes back twice; callers dedupe by tid.
export async function loadFills(master: Address, since: number): Promise<AccountFill[]> {
  const fills: AccountFill[] = [];
  let startTime = since;
  for (;;) {
    const page = (await info.userFillsByTime({ user: master, startTime })).map(toFill);
    fills.push(...page);
    const last = page.at(-1)?.time ?? startTime;
    if (page.length < FILLS_PER_PAGE || last <= startTime) return fills;
    startTime = last;
  }
}

export async function loadPosition(master: Address, coin: string): Promise<Position> {
  return toPosition(await info.clearinghouseState({ user: master }), coin);
}

export async function loadUnrealizedPnl(master: Address): Promise<number> {
  const state = await info.clearinghouseState({ user: master });
  return state.assetPositions.reduce((sum, p) => sum + parseNumber(p.position.unrealizedPnl), 0);
}

export async function loadFunding(master: Address, since: number) {
  const updates = await info.userFunding({ user: master, startTime: since });
  return updates.map((u) => ({ time: u.time, usdc: parseNumber(u.delta.usdc) }));
}

// Account mode and fee tier do not change within a session: read them once.
export async function loadProfile(master: Address) {
  const [abstraction, fees] = await Promise.all([
    info.userAbstraction({ user: master }),
    info.userFees({ user: master }),
  ]);
  return {
    unified: abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin',
    fees: { taker: parseNumber(fees.userCrossRate), maker: parseNumber(fees.userAddRate) },
  };
}

// Under a unified account the spot USDC total is the equity and already includes unrealized
// PnL; clearinghouseState balances are not meaningful there.
export async function loadLimits(
  master: Address,
  coin: string,
  { unified, fees }: Awaited<ReturnType<typeof loadProfile>>,
): Promise<AccountLimits> {
  const [spot, perp, asset] = await Promise.all([
    info.spotClearinghouseState({ user: master }),
    info.clearinghouseState({ user: master }),
    info.activeAssetData({ user: master, coin }),
  ]);
  const usdc = spot.balances.find((b) => b.coin === 'USDC');
  // maxTradeSzs is [buy, sell]: with a long open, the buy cap shrinks (observed on testnet).
  const [buy, sell] = asset.maxTradeSzs;
  return {
    equity: parseNumber(unified ? (usdc?.total ?? '0') : perp.marginSummary.accountValue),
    maxTradeSz: { long: parseNumber(buy), short: parseNumber(sell) },
    fees,
  };
}

export interface OrderUpdate {
  cloid: string | null;
  coin: string;
  status: string;
  origSz: string;
  sz: string;
}

interface AccountHandlers {
  onOrder: (update: OrderUpdate) => void;
  onFills: (fills: AccountFill[]) => void;
  onPosition: (position: Position) => void;
  onConnection: (connected: boolean) => void;
}

// The SDK socket reconnects and resubscribes; the caller reconciles from REST on reopen. A failed
// subscribe closes the socket here, so no handler outlives the error.
export async function subscribeAccount(
  master: Address,
  coin: string,
  handlers: AccountHandlers,
): Promise<() => void> {
  const transport = new WebSocketTransport({ isTestnet: true });
  transport.socket.addEventListener('open', () => {
    handlers.onConnection(true);
  });
  transport.socket.addEventListener('close', () => {
    handlers.onConnection(false);
  });
  const subscriptions = new SubscriptionClient({ transport });
  try {
    await Promise.all([
      subscriptions.orderUpdates({ user: master }, (updates) => {
        for (const u of updates) {
          handlers.onOrder({
            cloid: u.order.cloid ?? null,
            coin: u.order.coin,
            status: u.status,
            origSz: u.order.origSz,
            sz: u.order.sz,
          });
        }
      }),
      subscriptions.userFills({ user: master }, (event) => {
        if (!event.isSnapshot) handlers.onFills(event.fills.map(toFill));
      }),
      subscriptions.clearinghouseState({ user: master }, (event) => {
        handlers.onPosition(toPosition(event.clearinghouseState, coin));
      }),
    ]);
  } catch (error) {
    transport.close();
    throw error;
  }
  return () => {
    transport.close();
  };
}
