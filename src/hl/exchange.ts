import {
  ApiRequestError,
  ExchangeClient,
  HttpTransport,
  HyperliquidError,
  InfoClient,
  TransportError,
} from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { OrderSpec } from '../core/bracket/bracket';
import type { Cloid } from '../core/bracket/cloid';
import type { Address } from './account';
import { parseHlError, rejectionText } from './errors';
import {
  groupingFor,
  placeResult,
  statusView,
  toWireOrder,
  type OrderResult,
  type StatusView,
} from './orders';

// Orders only ever reach testnet: no setting or env var selects this network.
const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });

export function assertTestnet(): void {
  if (!transport.isTestnet) throw new Error('refusing: execution transport is not testnet');
}

export type QueryResult =
  { kind: 'unknown' } | { kind: 'uncertain' } | ({ kind: 'order' } & StatusView);

// An ApiRequestError is a confirmed answer. A transport failure (timeout, network) leaves the
// outcome unknown: the caller checks orderStatus before any retry.
async function act<T>(
  send: () => Promise<T>,
  read: (response: T) => OrderResult,
): Promise<OrderResult> {
  assertTestnet();
  try {
    return read(await send());
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return { status: 'rejected', error: parseHlError(rejectionText(error.response)) };
    }
    if (error instanceof TransportError) return { status: 'uncertain' };
    // Validation, formatting and signing fail before anything is sent: a sure rejection.
    if (error instanceof HyperliquidError) {
      return { status: 'rejected', error: { code: 'Unknown', message: error.message } };
    }
    throw error;
  }
}

function createClient(
  exchange: ExchangeClient,
  master: Address,
  universe: { name: string; szDecimals: number }[],
) {
  const asset = (coin: string) => {
    const index = universe.findIndex((u) => u.name === coin);
    const spec = universe[index];
    if (!spec) throw new Error(`unknown coin: ${coin}`);
    return { index, szDecimals: spec.szDecimals };
  };

  return {
    master,
    place(coin: string, cloid: Cloid, spec: OrderSpec) {
      const { index, szDecimals } = asset(coin);
      return act(
        () =>
          exchange.order({
            orders: [toWireOrder(index, szDecimals, cloid, spec)],
            grouping: groupingFor(spec),
          }),
        (response) => placeResult(response.response.data.statuses[0], spec),
      );
    },
    modify(coin: string, cloid: Cloid, next: Cloid, spec: OrderSpec) {
      const { index, szDecimals } = asset(coin);
      return act(
        () => exchange.modify({ oid: cloid, order: toWireOrder(index, szDecimals, next, spec) }),
        () => ({ status: 'resting' }),
      );
    },
    cancel(coin: string, cloid: Cloid) {
      const { index } = asset(coin);
      return act(
        () => exchange.cancelByCloid({ cancels: [{ asset: index, cloid }] }),
        () => ({ status: 'canceled' }),
      );
    },
    async orderStatus(coin: string, cloid: Cloid): Promise<QueryResult> {
      const { szDecimals } = asset(coin);
      try {
        const answer = await info.orderStatus({ user: master, oid: cloid });
        if (answer.status === 'unknownOid') return { kind: 'unknown' };
        return {
          kind: 'order',
          ...statusView(answer.order.order, answer.order.status, szDecimals),
        };
      } catch (error) {
        if (error instanceof TransportError) return { kind: 'uncertain' };
        throw error;
      }
    },
  };
}

export type ExecutionClient = ReturnType<typeof createClient>;

const isPrivateKey = (key: string): key is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(key);

// The key stays inside the viem account this closure keeps; it is never returned or stored.
// Only an agent key is accepted, so a master wallet key can never sign here.
export async function connectAgent(
  key: string,
): Promise<
  { ok: true; client: ExecutionClient } | { ok: false; error: 'malformed_key' | 'not_agent' }
> {
  if (!isPrivateKey(key)) return { ok: false, error: 'malformed_key' };
  const wallet = privateKeyToAccount(key);
  const [role, meta] = await Promise.all([info.userRole({ user: wallet.address }), info.meta()]);
  if (role.role !== 'agent') return { ok: false, error: 'not_agent' };
  assertTestnet();
  return {
    ok: true,
    client: createClient(new ExchangeClient({ transport, wallet }), role.data.user, meta.universe),
  };
}
