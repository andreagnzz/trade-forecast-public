import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  openBracket,
  phase,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type BracketFill,
  type BracketPlan,
} from './bracket';
import { parseCloid } from './cloid';
import { reduceBracket } from './reduce';

const PLAN: BracketPlan = {
  id: '00112233445566778899aabb',
  prefix: '7466',
  coin: 'ETH',
  side: 'short',
  entry: { type: 'gtc', px: 3000 },
  size: 0.5,
  szDecimals: 4,
  minNotionalUsd: 10,
  stopPx: 3030,
  tpPx: 2940,
  riskUsd: 16,
};

// lost: the request lands but its answer never comes back; dropped: it never lands.
type Fate = 'ok' | 'reject' | 'lost' | 'dropped';

type Action =
  | { kind: 'ack'; pick: number; fate: Fate }
  | { kind: 'entry_fill'; lots: number }
  | { kind: 'tp_fill'; lots: number; late: boolean }
  | { kind: 'reload'; land: boolean }
  | { kind: 'resync' }
  | { kind: 'sl_fire'; late: boolean }
  | { kind: 'sl_lost' | 'close' | 'sl_only' };

const lots = fc.integer({ min: 1, max: 3000 });
const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('ack' as const),
      pick: fc.nat(),
      fate: fc.oneof(
        { weight: 17, arbitrary: fc.constant<Fate>('ok') },
        { weight: 1, arbitrary: fc.constantFrom<Fate>('reject', 'lost', 'dropped') },
      ),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('entry_fill' as const), lots }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('tp_fill' as const), lots, late: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.oneof(
      fc.record({ kind: fc.constant('sl_fire' as const), late: fc.boolean() }),
      fc.record({
        kind: fc.constantFrom('sl_lost' as const, 'close' as const, 'sl_only' as const),
      }),
      fc.record({ kind: fc.constant('reload' as const), land: fc.boolean() }),
      fc.record({ kind: fc.constant('resync' as const) }),
    ),
  },
);

const round = (x: number) => Number(x.toFixed(4));
const legOf = (cloid: string) => parseCloid(cloid)?.leg;

// A small exchange: one book, one net short position, commands acked in random order, random
// rejects of protective legs, and fills of the entry, the take-profit and the stop.
function simulate(actions: Action[]) {
  const opened = openBracket(PLAN);
  let state: Bracket = opened.state;
  const pending: BracketCommand[] = [...opened.commands];
  const book = new Map<string, { size: number; filled: number }>();
  const finished = new Map<string, Extract<BracketEvent, { type: 'order' }>>();
  const fills: BracketFill[] = [];
  let position = 0;
  let entryPlaces = 0;
  let tid = 0;
  const violations: string[] = [];
  let muted = false;

  const feed = (event: BracketEvent) => {
    if (muted) return;
    const step = reduceBracket(state, event);
    state = step.state;
    for (const command of step.commands) {
      if (command.type === 'place' && legOf(command.cloid) === 'entry') entryPlaces += 1;
      if (command.type === 'cancel' && legOf(command.cloid) === 'sl' && position > 0) {
        violations.push('stop cancelled with a position open');
      }
      // Only fills still on their way can make the bracket see a position the exchange closed.
      const sent =
        command.type === 'modify' ? command.next : command.type === 'place' && command.cloid;
      if (sent && legOf(sent) === 'tp' && position <= 0) {
        violations.push('take-profit sent with no position');
      }
    }
    pending.push(...step.commands);
  };
  const finish = (cloid: string, status: 'filled' | 'canceled') => {
    const event = {
      type: 'order',
      cloid,
      status,
      filledSz: book.get(cloid)?.filled ?? 0,
    } as const;
    book.delete(cloid);
    finished.set(cloid, event);
    feed(event);
  };
  // The exchange books a fill at once; the user's fill stream may deliver it later.
  const bookFill = (cloid: string, size: number, isBuy: boolean) => {
    const record = { tid: tid++, cloid, isBuy, size, closedPnl: 0, fee: 0, time: tid };
    fills.push(record);
    position = round(position + (isBuy ? -size : size));
    return () => {
      feed({ type: 'fill', ...record });
    };
  };
  const fill = (cloid: string, size: number, isBuy: boolean) => {
    bookFill(cloid, size, isBuy)();
  };
  const restingOf = (name: string) => [...book.keys()].find((cloid) => legOf(cloid) === name);

  const execute = (command: BracketCommand, fate: Fate) => {
    if (
      (fate === 'lost' || fate === 'dropped') &&
      command.type !== 'retry' &&
      command.type !== 'wait_fills' &&
      command.type !== 'query'
    ) {
      if (fate === 'lost') {
        muted = true;
        execute(command, 'ok');
        muted = false;
      }
      const cloid = command.type === 'modify' ? command.next : command.cloid;
      feed({ type: 'uncertain', cloid });
      return;
    }
    const reject = fate === 'reject';
    switch (command.type) {
      case 'place': {
        const name = legOf(command.cloid);
        if (book.has(command.cloid) || finished.has(command.cloid)) {
          violations.push(`cloid sent twice: ${command.cloid}`);
        }
        if (reject && name !== 'entry') {
          feed({ type: 'rejected', cloid: command.cloid, reason: 'other' });
          return;
        }
        if (name === 'close') {
          if (position > 0) fill(command.cloid, position, true);
          finish(command.cloid, 'filled');
          return;
        }
        book.set(command.cloid, { size: command.order.size, filled: 0 });
        feed({ type: 'order', cloid: command.cloid, status: 'open', filledSz: 0 });
        return;
      }
      case 'modify':
        if (reject || !book.has(command.cloid)) {
          feed({ type: 'rejected', cloid: command.next, reason: 'other' });
          return;
        }
        book.delete(command.cloid);
        book.set(command.next, { size: command.order.size, filled: 0 });
        feed({ type: 'order', cloid: command.next, status: 'open', filledSz: 0 });
        feed({ type: 'order', cloid: command.cloid, status: 'canceled', filledSz: 0 });
        return;
      case 'cancel':
        if (book.has(command.cloid)) finish(command.cloid, 'canceled');
        else execute({ type: 'query', cloid: command.cloid }, 'ok');
        return;
      case 'query': {
        const done = finished.get(command.cloid);
        if (book.has(command.cloid)) {
          feed({ type: 'order', cloid: command.cloid, status: 'open', filledSz: 0 });
        } else if (done) {
          feed(done);
        } else {
          feed({ type: 'unknown', cloid: command.cloid });
        }
        return;
      }
      case 'retry':
        feed({ type: 'retry_due', leg: command.leg });
        return;
      case 'wait_fills':
        feed({ type: 'fills_due', leg: command.leg });
    }
  };

  const fillResting = (name: 'entry' | 'tp', requested: number, late = false) => {
    const cloid = restingOf(name);
    const order = cloid ? book.get(cloid) : undefined;
    if (!cloid || !order || (name === 'tp' && position <= 0)) return;
    const cap = name === 'tp' ? position : Infinity;
    const size = round(Math.min(order.size - order.filled, cap, requested));
    if (size <= 0) return;
    order.filled = round(order.filled + size);
    const deliver = bookFill(cloid, size, name === 'tp');
    if (!late) deliver();
    if (order.filled >= order.size) finish(cloid, 'filled');
    if (late) deliver();
  };

  for (const a of actions) {
    switch (a.kind) {
      case 'ack': {
        const [command] = pending.splice(a.pick % Math.max(1, pending.length), 1);
        if (command) execute(command, a.fate);
        break;
      }
      case 'entry_fill':
        fillResting('entry', a.lots / 10_000);
        break;
      case 'tp_fill':
        fillResting('tp', a.lots / 10_000, a.late);
        break;
      case 'sl_fire': {
        const cloid = restingOf('sl');
        const stop = cloid ? book.get(cloid) : undefined;
        if (!cloid || !stop) break;
        // As seen on testnet: triggered with the take-profit pulled as reduce-only in one
        // update, then filled; the fill comes before or after it.
        feed({ type: 'order', cloid, status: 'triggered', filledSz: 0 });
        const tp = restingOf('tp');
        if (tp) finish(tp, 'canceled');
        stop.filled = Math.max(position, 0);
        const deliver = position > 0 ? bookFill(cloid, position, true) : () => undefined;
        if (!a.late) deliver();
        finish(cloid, 'filled');
        if (a.late) deliver();
        break;
      }
      case 'close':
        feed({ type: 'close', px: 3100 });
        break;
      case 'sl_only':
        feed({ type: 'sl_only' });
        break;
      case 'sl_lost': {
        const cloid = restingOf('sl');
        if (cloid) finish(cloid, 'canceled');
        break;
      }
      case 'reload': {
        // The old page dies: its requests land or not, unseen, and its timers are gone.
        muted = true;
        for (const command of pending.splice(0)) if (a.land) execute(command, 'ok');
        muted = false;
        const open = [...book].map(([cloid, o]) => ({ cloid, size: round(o.size - o.filled) }));
        feed({ type: 'snapshot', reload: true, open, fills: [...fills] });
        break;
      }
      case 'resync': {
        // The same page reads the book while its own requests are still in flight.
        const open = [...book].map(([cloid, o]) => ({ cloid, size: round(o.size - o.filled) }));
        feed({ type: 'snapshot', reload: false, open, fills: [...fills] });
      }
    }
    if ([...book.keys()].filter((cloid) => legOf(cloid) === 'tp').length > 1) {
      violations.push('two take-profits resting');
    }
  }
  for (let guard = 0; pending.length > 0 && guard < 500; guard++) {
    const command = pending.shift();
    if (command) execute(command, 'ok');
  }
  return { state, position, book, entryPlaces, violations };
}

describe('bracket against a simulated exchange', () => {
  it('keeps every invariant under random fills, rejects, lost stops, reloads and resyncs', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 80 }), (actions) => {
        const { state, position, book, entryPlaces, violations } = simulate(actions);
        expect(violations).toEqual([]);
        expect(entryPlaces).toBeLessThanOrEqual(1);
        if (state.outcome?.kind === 'closed') expect(position).toBe(0);
        if (state.outcome) expect([...book.keys()]).toEqual([]);
        expect(phase(state)).not.toBe('closing');
        if (position > 0 && state.attention !== 'sl_failed') {
          expect([...book.keys()].some((cloid) => legOf(cloid) === 'sl')).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
