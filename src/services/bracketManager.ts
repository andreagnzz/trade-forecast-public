import {
  openBracket,
  stopCrossed,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type BracketPlan,
  type Step,
} from '../core/bracket/bracket';
import { parseCloid, type Cloid } from '../core/bracket/cloid';
import { currentLeg } from '../core/bracket/legs';
import type { UserEvent } from '../core/bracket/choices';
import { reduceBracket } from '../core/bracket/reduce';
import type { AccountFill, AccountOrder, OrderUpdate, Position } from '../hl/account';
import { messageOf } from '../hl/errors';
import type { ExecutionClient } from '../hl/exchange';
import {
  queryEvent,
  sendEvent,
  toBracketFill,
  updateEvent,
  type Translated,
} from './bracketEvents';
import { readSaved, type Saved } from './savedBracket';
import type { OrderService, SendResult } from './orderService';

interface BracketManagerDeps {
  orders: Pick<OrderService, 'check' | 'send'>;
  client: Pick<ExecutionClient, 'orderStatus'>;
  reads: {
    openOrders: () => Promise<AccountOrder[]>;
    fills: (since: number) => Promise<AccountFill[]>;
    position: (coin: string) => Promise<Position>;
  };
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey: string;
  clock: { setTimeout: (run: () => void, ms: number) => void };
  onChange: (view: BracketView) => void;
}

export interface BracketView {
  bracket: Bracket | null;
  lastError: string | null;
}

// Brackets are told apart by 12 random bytes in every cloid.
export const randomBracketId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

export type SendRefusal =
  'bracket_active' | 'coin_busy' | 'blocked' | 'no_mark' | 'stop_crossed' | 'stats_unavailable';

const QUERY_RETRY_MS = 1000;
const SYNC_RETRY_MS = 2000;

// Runs the pure reducer against the exchange: persists every step, executes its commands one
// at a time, and feeds every answer, socket update and fill back in as an event.
export function createBracketManager(deps: BracketManagerDeps) {
  const { orders, client, reads, storage, storageKey, clock } = deps;
  let saved: Saved | null = null;
  let lastError: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const notify = () => {
    deps.onChange({ bracket: saved?.bracket ?? null, lastError });
  };

  // Orders go out first: a failing storage or view must never hold back a stop.
  function commit(step: Step) {
    if (!saved) return;
    saved.bracket = step.state;
    for (const command of step.commands) enqueue(command);
    if (step.state.outcome) storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify(saved));
    notify();
  }

  function dispatch(event: BracketEvent) {
    if (saved) commit(reduceBracket(saved.bracket, event));
  }

  function hear(translated: Translated) {
    if (translated.error) lastError = translated.error;
    if (translated.event) dispatch(translated.event);
    else if (translated.error) notify();
  }

  // The coin is fixed when the command is queued: a later bracket may trade another one.
  // A failure is shown and the queue keeps running, or every later order would stall.
  function enqueue(command: BracketCommand) {
    if (!saved) return;
    const { coin } = saved.bracket.plan;
    queue = queue
      .then(() => execute(command, coin))
      .catch((error: unknown) => {
        lastError = `internal error: ${messageOf(error)}`;
        notify();
        // Whether the order left, or the cancel landed, is unknown: ask the exchange rather than
        // leave it in flight.
        if (command.type === 'place') dispatch({ type: 'uncertain', cloid: command.cloid });
        if (command.type === 'modify') dispatch({ type: 'uncertain', cloid: command.next });
        if (command.type === 'cancel' || command.type === 'query') {
          const query = { type: 'query', cloid: command.cloid } as const;
          clock.setTimeout(() => {
            if (stillCurrent(query.cloid)) enqueue(query);
          }, QUERY_RETRY_MS);
        }
      });
  }

  // Only the bracket's current legs are worth asking about again.
  const stillCurrent = (cloid: string) =>
    !!saved && !saved.bracket.outcome && currentLeg(saved.bracket, cloid) !== null;

  // An entry's final filled size, or the fate of an order already gone, comes from
  // orderStatus rather than from the cancel answer.
  function afterCancel(cloid: Cloid, answer: SendResult) {
    const query = { type: 'query', cloid } as const;
    if (answer.status === 'canceled' && parseCloid(cloid)?.leg !== 'entry') {
      dispatch({ type: 'order', cloid, status: 'canceled', filledSz: 0 });
      return;
    }
    // An unreachable exchange would otherwise turn cancel, status, cancel into a tight loop
    // that deepens a rate limit.
    if (answer.status === 'uncertain') {
      clock.setTimeout(() => {
        enqueue(query);
      }, QUERY_RETRY_MS);
      return;
    }
    enqueue(query);
  }

  async function execute(command: BracketCommand, coin: string) {
    switch (command.type) {
      case 'place':
        hear(sendEvent(command.cloid, await orders.send(coin, command)));
        return;
      case 'modify':
        hear(sendEvent(command.next, await orders.send(coin, command)));
        return;
      case 'cancel':
        afterCancel(command.cloid, await orders.send(coin, command));
        return;
      case 'query': {
        const translated = queryEvent(command.cloid, await client.orderStatus(coin, command.cloid));
        if (translated) {
          hear(translated);
          return;
        }
        if (!stillCurrent(command.cloid)) return;
        lastError = 'order status unknown, checking again';
        notify();
        clock.setTimeout(() => {
          if (stillCurrent(command.cloid)) enqueue(command);
        }, QUERY_RETRY_MS);
        return;
      }
      case 'retry':
        clock.setTimeout(() => {
          dispatch({ type: 'retry_due', leg: command.leg });
        }, command.delayMs);
        return;
      case 'wait_fills':
        clock.setTimeout(() => {
          dispatch({ type: 'fills_due', leg: command.leg });
        }, command.delayMs);
    }
  }

  // One position per coin on HL: a bracket only starts on a flat coin with no order resting.
  // `starting` closes the gap between two quick Sends while the first one reads the book.
  let starting = false;
  async function send(plan: BracketPlan, markPx: number): Promise<SendRefusal | null> {
    if (starting || (saved && !saved.bracket.outcome)) return 'bracket_active';
    if (!(Number.isFinite(markPx) && markPx > 0)) return 'no_mark';
    if (stopCrossed(plan, markPx)) return 'stop_crossed';
    starting = true;
    try {
      return await start(plan);
    } finally {
      starting = false;
    }
  }

  async function start(plan: BracketPlan): Promise<SendRefusal | null> {
    const [open, position] = await Promise.all([reads.openOrders(), reads.position(plan.coin)]);
    if (position.sz > 0 || open.some((o) => o.coin === plan.coin)) return 'coin_busy';
    const verdict = await orders.check({ kind: 'place', reduceOnly: false });
    if (!verdict) return 'stats_unavailable';
    if (verdict.verdict === 'block') return 'blocked';
    const step = openBracket(plan);
    // Exchange time, not the local clock: fills are stamped by the exchange.
    saved = { version: 3, since: position.time, bracket: step.state };
    lastError = null;
    commit(step);
    return null;
  }

  // Returns false when the exchange could not be read; it tries again on its own.
  async function reconcile(): Promise<boolean> {
    if (!saved || saved.bracket.outcome) return true;
    const { coin } = saved.bracket.plan;
    const { since } = saved;
    let open: AccountOrder[];
    let fills: AccountFill[];
    try {
      [open, fills] = await Promise.all([reads.openOrders(), reads.fills(since)]);
    } catch (error) {
      lastError = `sync failed, retrying: ${messageOf(error)}`;
      notify();
      clock.setTimeout(() => {
        void reconcile();
      }, SYNC_RETRY_MS);
      return false;
    }
    dispatch({
      type: 'snapshot',
      open: open.flatMap((o) =>
        o.coin === coin && o.cloid ? [{ cloid: o.cloid, size: o.sz }] : [],
      ),
      fills: fills.filter((f) => f.coin === coin && f.time > since).map(toBracketFill),
    });
    return true;
  }

  // Its orders may still rest on the exchange, untracked.
  function dropSaved() {
    saved = null;
    storage.removeItem(storageKey);
    lastError = 'saved bracket unreadable, dropped: check open orders';
    notify();
  }

  async function load() {
    const raw = storage.getItem(storageKey);
    saved = readSaved(raw);
    if (raw !== null && !saved) {
      dropSaved();
      return;
    }
    notify();
    // The shape check is shallow: a blob missing a deeper field throws in the reducer, before any
    // command is queued.
    try {
      await reconcile();
    } catch {
      dropSaved();
    }
  }

  function onOrderUpdate(update: OrderUpdate) {
    const { cloid } = update;
    if (!saved || cloid === null || parseCloid(cloid)?.bracketId !== saved.bracket.plan.id) return;
    hear(updateEvent({ ...update, cloid }, saved.bracket.plan.szDecimals));
  }

  function onFills(fills: AccountFill[]) {
    for (const f of fills) {
      if (f.coin === saved?.bracket.plan.coin && f.time > saved.since) {
        dispatch({ type: 'fill', ...toBracketFill(f) });
      }
    }
  }

  return {
    send,
    load,
    reconcile,
    onOrderUpdate,
    onFills,
    choose: (event: Exclude<UserEvent, { type: 'dismiss' }>) => {
      dispatch(event);
    },
    // A single unknownOid can race an order still in flight: look at the book once more first.
    dismiss: async () => {
      if (await reconcile()) dispatch({ type: 'dismiss' });
    },
    // Commands queue more commands; wait until the queue stops growing.
    settled: async () => {
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
  };
}

export type BracketManager = ReturnType<typeof createBracketManager>;
