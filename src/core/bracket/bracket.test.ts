import { describe, expect, it } from 'vitest';
import {
  isUnprotected,
  openBracket,
  openSize,
  phase,
  rMultiple,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type BracketPlan,
  type RejectReason,
} from './bracket';
import { makeCloid, type LegName } from './cloid';
import { reduceBracket } from './reduce';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const T0 = Date.UTC(2026, 9, 12, 10);

const PLAN: BracketPlan = {
  id: ID,
  prefix: '7466',
  coin: 'BTC',
  side: 'long',
  entry: { type: 'gtc', px: 80_000 },
  size: 0.003,
  szDecimals: 5,
  minNotionalUsd: 10,
  stopPx: 79_000,
  tpPx: 82_000,
  riskUsd: 3.5,
};

const IOC: BracketPlan = { ...PLAN, entry: { type: 'ioc', px: 80_100 } };

const c = (leg: LegName, seq = 0) => makeCloid('7466', ID, leg, seq);

let tid = 1;
const fill = (isBuy: boolean, size: number, pnl: number, cloid: string | null) =>
  ({ type: 'fill', tid: tid++, cloid, isBuy, size, closedPnl: pnl, fee: 0, time: T0 }) as const;
const buy = (size: number) => fill(true, size, 0, c('entry'));
const sell = (size: number, pnl = 0, cloid: string | null = null) => fill(false, size, pnl, cloid);
const order = (cloid: string, status: 'open' | 'filled' | 'canceled' | 'triggered', filledSz = 0) =>
  ({ type: 'order', cloid, status, filledSz }) as const;
const rejected = (cloid: string, reason: RejectReason = 'other') =>
  ({ type: 'rejected', cloid, reason }) as const;

function run(start: Bracket, ...events: BracketEvent[]) {
  let state = start;
  const commands: BracketCommand[] = [];
  for (const event of events) {
    const step = reduceBracket(state, event);
    state = step.state;
    commands.push(...step.commands);
  }
  return { state, commands };
}

const cancels = (commands: BracketCommand[]) => commands.filter((cmd) => cmd.type === 'cancel');

// The position stop rests and the entry is sent.
const working = (plan: BracketPlan = PLAN) =>
  run(openBracket(plan).state, order(c('sl'), 'open')).state;
// The entry rests on the book too.
const resting = () => run(working(), order(c('entry'), 'open')).state;
// Fully filled with the take-profit resting.
const filled = () =>
  run(working(), buy(0.003), order(c('entry'), 'filled', 0.003), order(c('tp'), 'open')).state;

describe('send', () => {
  it('places the position stop before anything else', () => {
    const { state, commands } = openBracket(PLAN);
    expect(commands).toEqual([
      {
        type: 'place',
        cloid: c('sl'),
        order: { isBuy: false, px: 79_000, size: 0, reduceOnly: true, type: 'stop_market' },
      },
    ]);
    expect(phase(state)).toBe('submitting');
  });

  it('sends the entry only once the stop rests', () => {
    expect(run(openBracket(PLAN).state, order(c('sl'), 'open')).commands).toEqual([
      {
        type: 'place',
        cloid: c('entry'),
        order: { isBuy: true, px: 80_000, size: 0.003, reduceOnly: false, type: 'gtc' },
      },
    ]);
  });

  it('never sends the entry when the stop is rejected', () => {
    const { state, commands } = run(openBracket(PLAN).state, rejected(c('sl')));
    expect(commands).toEqual([]);
    expect(state.outcome).toEqual({ kind: 'cancelled', reason: 'sl_rejected' });
  });

  it('cancels the bracket when the stop never reaches the book before the entry left', () => {
    let state = openBracket(PLAN).state;
    for (let seq = 0; seq < 5; seq++) {
      state = run(
        state,
        { type: 'unknown', cloid: c('sl', seq) },
        { type: 'retry_due', leg: 'sl' },
      ).state;
    }
    expect(state.attention).toBeNull();
    expect(state.outcome).toEqual({ kind: 'cancelled', reason: 'sl_rejected' });
  });

  it('mirrors every leg for a short', () => {
    const plan = { ...PLAN, side: 'short' as const, stopPx: 81_000, tpPx: 78_000 };
    const open = openBracket(plan);
    const { state, commands } = run(open.state, order(c('sl'), 'open'), sell(0.003));
    expect(open.commands[0]).toMatchObject({ order: { isBuy: true, px: 81_000 } });
    expect(commands[0]).toMatchObject({ order: { isBuy: false, type: 'gtc' } });
    expect(commands[1]).toMatchObject({ order: { isBuy: true, px: 78_000, size: 0.003 } });
    expect(openSize(state)).toBe(0.003);
  });
});

describe('fills', () => {
  it('places a post-only reduce-only take-profit at the filled size on the first fill', () => {
    const { state, commands } = run(working(), buy(0.001));
    expect(commands).toEqual([
      {
        type: 'place',
        cloid: c('tp'),
        order: { isBuy: false, px: 82_000, size: 0.001, reduceOnly: true, type: 'alo' },
      },
    ]);
    expect(phase(state)).toBe('partial');
    expect(isUnprotected(state)).toBe(false);
  });

  it('resizes the take-profit under a fresh cloid after each new fill', () => {
    const { state, commands } = run(working(), buy(0.001), order(c('tp'), 'open'), buy(0.0012));
    expect(commands.at(-1)).toEqual({
      type: 'modify',
      cloid: c('tp'),
      next: c('tp', 1),
      order: { isBuy: false, px: 82_000, size: 0.0022, reduceOnly: true, type: 'alo' },
    });
    expect(state.tp.seq).toBe(1);
  });

  it('waits for the in-flight take-profit before resizing it', () => {
    const { commands } = run(working(), buy(0.001), buy(0.001), order(c('tp'), 'open'));
    expect(commands.map((cmd) => cmd.type)).toEqual(['place', 'modify']);
    expect(commands[1]).toMatchObject({ order: { size: 0.002 } });
  });

  it('ignores the cancel HL emits for the order a modify replaced', () => {
    const { state, commands } = run(
      working(),
      buy(0.001),
      order(c('tp'), 'open'),
      buy(0.001),
      order(c('tp', 1), 'open'),
      order(c('tp'), 'canceled'),
    );
    expect(commands.map((cmd) => cmd.type)).toEqual(['place', 'modify']);
    expect(state.tp.status).toBe('live');
  });

  it('counts a fill once when it is delivered twice', () => {
    const duplicate = buy(0.001);
    const { state, commands } = run(working(), duplicate, duplicate);
    expect(state.filledSz).toBe(0.001);
    expect(commands).toHaveLength(1);
  });

  it('is protected once the entry is done and the take-profit matches the position', () => {
    expect(phase(filled())).toBe('protected');
  });

  it('cancels the rest of a partial entry on request', () => {
    const { commands } = run(resting(), buy(0.001), { type: 'cancel_entry' });
    expect(commands.at(-1)).toEqual({ type: 'cancel', cloid: c('entry') });
  });

  it('keeps the stop when the entry reports filled before its fill arrives', () => {
    const { state, commands } = run(working(), order(c('entry'), 'filled', 0.003));
    expect(commands).toEqual([]);
    expect(state.cancelling).toBeNull();
  });

  it('adds sizes without float drift', () => {
    const { state } = run(working(), buy(0.00019), buy(0.00015));
    expect(state.filledSz).toBe(0.00034);
  });

  it('resizes the take-profit to the open size after a partial take-profit fill', () => {
    const { commands } = run(
      working(),
      buy(0.002),
      order(c('tp'), 'open'),
      sell(0.001, 0, c('tp')),
      buy(0.001),
    );
    expect(commands.at(-1)).toMatchObject({ type: 'modify', order: { size: 0.002 } });
  });

  it('waits for fills worth the minimum before placing the take-profit', () => {
    const small = run(working(), buy(0.00006));
    expect(small.commands).toEqual([]);
    const { commands } = run(small.state, buy(0.00013));
    expect(commands).toEqual([
      {
        type: 'place',
        cloid: c('tp'),
        order: { isBuy: false, px: 82_000, size: 0.00019, reduceOnly: true, type: 'alo' },
      },
    ]);
  });

  it('places a small take-profit once the entry is finished, as an exact close', () => {
    const { commands } = run(working(), buy(0.00006), order(c('entry'), 'canceled', 0.00006));
    expect(commands.at(-1)).toMatchObject({ type: 'place', order: { size: 0.00006 } });
  });
});

describe('entry without fill', () => {
  it('tracks an unknown entry that lands after all, and cancels its rest when flat', () => {
    const lost = run(
      working(),
      { type: 'uncertain', cloid: c('entry') },
      {
        type: 'unknown',
        cloid: c('entry'),
      },
    ).state;
    const landed = run(lost, order(c('entry'), 'open'), buy(0.001), order(c('tp'), 'open'));
    expect(landed.state.entry.status).toBe('live');
    const flat = run(landed.state, sell(0.001, 1, c('tp')), order(c('tp'), 'filled', 0.001));
    expect(flat.commands).toContainEqual({ type: 'cancel', cloid: c('entry') });
    expect(flat.state.outcome).toBeNull();
  });

  it('removes the stop when the entry ends unfilled, then reports cancelled', () => {
    const cancelled = run(working(), order(c('entry'), 'canceled', 0));
    expect(cancelled.commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
    expect(phase(cancelled.state)).toBe('closing');
    const done = run(cancelled.state, order(c('sl'), 'canceled'));
    expect(done.state.outcome).toEqual({ kind: 'cancelled', reason: 'no_fill' });
  });

  it('cancels the stop when the exchange rejects the entry', () => {
    const { commands } = run(working(), rejected(c('entry')));
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
  });

  it('never resends an entry whose outcome was lost, it queries instead', () => {
    expect(run(working(), { type: 'uncertain', cloid: c('entry') }).commands).toEqual([
      { type: 'query', cloid: c('entry') },
    ]);
  });

  it('asks the user when the exchange has never seen the entry, keeping the stop', () => {
    const { state, commands } = run(working(), { type: 'unknown', cloid: c('entry') });
    expect(commands).toEqual([]);
    expect(state.attention).toBe('entry_unknown');
    expect(run(state, { type: 'dismiss' }).commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
  });

  it('resumes when a fill shows the unknown entry did land', () => {
    const lost = run(working(), { type: 'unknown', cloid: c('entry') }).state;
    const { state, commands } = run(lost, buy(0.003));
    expect(state.attention).toBeNull();
    expect(commands[0]).toMatchObject({ type: 'place', cloid: c('tp') });
  });

  it('stops working the entry when the stop fires before any fill', () => {
    const { state, commands } = run(resting(), order(c('sl'), 'triggered'));
    expect(commands).toEqual([{ type: 'cancel', cloid: c('entry') }]);
    expect(state.cancelling).toBe('no_fill');
  });

  it('keeps protecting an entry that fills after its stop fired early', () => {
    const { state, commands } = run(
      working(),
      order(c('sl'), 'triggered'),
      order(c('sl'), 'filled', 0),
      order(c('entry'), 'filled', 0.003),
      buy(0.003),
    );
    expect(state.outcome).toBeNull();
    expect(state.cancelling).toBeNull();
    expect(commands).toContainEqual(expect.objectContaining({ type: 'place', cloid: c('sl', 1) }));
  });

  it('protects an entry that fills after its stop fired while flat, with no stop event after', () => {
    const { state, commands } = run(
      working(IOC),
      order(c('sl'), 'triggered'),
      order(c('entry'), 'filled', 0.003),
      buy(0.003),
    );
    expect(commands).toContainEqual(expect.objectContaining({ type: 'place', cloid: c('sl', 1) }));
    expect(run(state, order(c('sl', 1), 'open')).state.sl.status).toBe('live');
  });

  it('never ends a bracket whose entry fate is unknown', () => {
    const { state } = run(
      working(IOC),
      order(c('sl'), 'triggered'),
      { type: 'uncertain', cloid: c('entry') },
      { type: 'unknown', cloid: c('entry') },
    );
    expect(state.outcome).toBeNull();
    expect(phase(state)).toBe('attention');
    expect(state.attention).toBe('entry_unknown');
  });

  it('waits for every announced fill before ending an unfilled bracket', () => {
    const { state } = run(
      working(),
      order(c('sl'), 'triggered'),
      order(c('entry'), 'filled', 0.003),
    );
    expect(state.outcome).toBeNull();
  });
});

describe('take-profit rejected', () => {
  const crossed = () =>
    run(
      working(),
      buy(0.003),
      order(c('entry'), 'filled', 0.003),
      rejected(c('tp'), 'post_only_would_cross'),
    );

  it('stops and asks instead of falling back silently', () => {
    const { state, commands } = crossed();
    expect(state.attention).toBe('tp_would_cross');
    expect(commands.slice(1)).toEqual([]);
    expect(isUnprotected(state)).toBe(false);
  });

  it('rests the take-profit at the price the user picks', () => {
    const { state, commands } = run(crossed().state, { type: 'tp_at', px: 82_500 });
    expect(commands).toEqual([
      {
        type: 'place',
        cloid: c('tp', 1),
        order: { isBuy: false, px: 82_500, size: 0.003, reduceOnly: true, type: 'alo' },
      },
    ]);
    expect(state.attention).toBeNull();
  });

  it('keeps only the stop when the user says so', () => {
    const { state, commands } = run(crossed().state, { type: 'sl_only' });
    expect(commands).toEqual([]);
    expect(phase(state)).toBe('protected');
  });

  it('takes profit at market with a reduce-only close of the open size', () => {
    expect(run(crossed().state, { type: 'close', px: 81_800 }).commands).toEqual([
      {
        type: 'place',
        cloid: c('close'),
        order: { isBuy: false, px: 81_800, size: 0.003, reduceOnly: true, type: 'ioc' },
      },
    ]);
  });

  it('ignores a choice with an unusable price', () => {
    expect(run(crossed().state, { type: 'close', px: Number.NaN }).commands).toEqual([]);
    expect(run(crossed().state, { type: 'tp_at', px: 0 }).state.attention).toBe('tp_would_cross');
  });

  it('asks the user when the take-profit is below the minimum notional', () => {
    const { state } = run(
      working(),
      buy(0.0001),
      order(c('entry'), 'filled', 0.0001),
      rejected(c('tp'), 'below_min_notional'),
    );
    expect(state.attention).toBe('tp_below_min');
  });

  it('keeps tracking the old take-profit when a resize is refused, and can cancel it', () => {
    const refused = run(
      working(),
      buy(0.001),
      order(c('tp'), 'open'),
      buy(0.001),
      rejected(c('tp', 1), 'post_only_would_cross'),
    ).state;
    expect(refused.tp).toMatchObject({ seq: 0, status: 'live', size: 0.001, prev: null });
    expect(run(refused, { type: 'sl_only' }).commands).toEqual([
      { type: 'cancel', cloid: c('tp') },
    ]);
  });

  it('goes back to the old take-profit when the resize never reached the exchange', () => {
    const { state, commands } = run(working(), buy(0.001), order(c('tp'), 'open'), buy(0.001), {
      type: 'unknown',
      cloid: c('tp', 1),
    });
    expect(commands.at(-1)).toEqual({
      type: 'modify',
      cloid: c('tp'),
      next: c('tp', 2),
      order: { isBuy: false, px: 82_000, size: 0.002, reduceOnly: true, type: 'alo' },
    });
    expect(state.tp.prev).toEqual({ seq: 0, size: 0.001, px: 82_000 });
  });

  it('retries a take-profit rejected for another reason, then gives up after five', () => {
    let state = run(working(), buy(0.003)).state;
    for (let seq = 0; seq < 5; seq++) {
      state = run(state, rejected(c('tp', seq)), { type: 'retry_due', leg: 'tp' }).state;
    }
    expect(state.attention).toBe('tp_failed');
    expect(phase(state)).toBe('attention');
  });

  it('tracks a fill on the old take-profit while its resize is in flight', () => {
    const { state } = run(
      working(),
      buy(0.002),
      order(c('tp'), 'open'),
      buy(0.001),
      sell(0.001, 0, c('tp')),
      rejected(c('tp', 1)),
    );
    expect(state.tp).toMatchObject({ seq: 0, size: 0.001, status: 'live' });
  });

  it('stops resizing and asks the user once the take-profit has used every seq', () => {
    const live = run(working(), buy(0.001), order(c('tp'), 'open')).state;
    const last = run({ ...live, tp: { ...live.tp, maxSeq: 254 } }, buy(0.001));
    expect(last.commands).toEqual([
      expect.objectContaining({ type: 'modify', next: c('tp', 255) }),
    ]);
    expect(last.state.tp.seq).toBe(255);
    const exhausted = { ...live, tp: { ...live.tp, maxSeq: 255 } };
    const { state, commands } = run(exhausted, buy(0.001));
    expect(commands).toEqual([]);
    expect(state.attention).toBe('tp_failed');
    expect(state.tp.status).toBe('live');
  });

  it('never sends a take-profit cloid twice when the user picks a price after five failures', () => {
    const events: BracketEvent[] = [buy(0.003)];
    for (let seq = 0; seq < 5; seq++) {
      events.push(rejected(c('tp', seq)), { type: 'retry_due', leg: 'tp' });
    }
    events.push({ type: 'tp_at', px: 81_900 });
    const { state, commands } = run(working(), ...events);
    const placed = commands.flatMap((cmd) => (cmd.type === 'place' ? [cmd.cloid] : []));
    expect(state.tp.status).toBe('sending');
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('shows a take-profit picked after five failures as pending until it can rest', () => {
    const events: BracketEvent[] = [buy(0.00013)];
    for (let seq = 0; seq < 5; seq++) {
      events.push(rejected(c('tp', seq)), { type: 'retry_due', leg: 'tp' });
    }
    events.push({ type: 'tp_at', px: 75_000 });
    const { state } = run(working(), ...events);
    expect(state.tp.status).toBe('idle');
  });

  it('never reuses the cloid of a refused resize for the next one', () => {
    const { commands } = run(
      resting(),
      buy(0.001),
      order(c('tp'), 'open'),
      buy(0.001),
      rejected(c('tp', 1), 'post_only_would_cross'),
      { type: 'tp_at', px: 81_900 },
    );
    expect(commands.at(-1)).toMatchObject({ type: 'modify', cloid: c('tp'), next: c('tp', 2) });
  });

  it('treats a resize of a take-profit HL already pulled as gone, not as a failure', () => {
    const shrinking = run(filled(), sell(0.001)).state;
    expect(shrinking.tp.prev).not.toBeNull();
    const gone = run(shrinking, rejected(c('tp', 1), 'order_gone'));
    expect(gone.state.attention).toBeNull();
    expect(gone.commands.find((cmd) => cmd.type === 'place')).toMatchObject({
      cloid: c('tp', 2),
      order: { size: 0.002 },
    });
    const closed = run(
      gone.state,
      sell(0.002),
      order(c('tp', 2), 'canceled'),
      order(c('sl'), 'canceled'),
    );
    expect(closed.state.outcome).toEqual({ kind: 'closed' });
  });
});

describe('close and OCO cleanup', () => {
  it('cancels the take-profit when the stop fills, then reports the result in R', () => {
    const fired = run(
      filled(),
      order(c('sl'), 'triggered'),
      sell(0.003, -3.2),
      order(c('sl'), 'filled', 0.003),
    );
    expect(cancels(fired.commands)).toEqual([{ type: 'cancel', cloid: c('tp') }]);
    const { state } = run(fired.state, order(c('tp'), 'canceled'));
    expect(state.outcome).toEqual({ kind: 'closed' });
    expect(rMultiple(state)).toBeCloseTo(-3.2 / 3.5);
  });

  it('cancels the stop when the take-profit fills', () => {
    const { state, commands } = run(
      filled(),
      sell(0.003, 6, c('tp')),
      order(c('tp'), 'filled', 0.003),
    );
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
    expect(run(state, order(c('sl'), 'canceled')).state.outcome).toEqual({ kind: 'closed' });
  });

  it('places nothing while a fired stop announces its exit before the fill', () => {
    const { state, commands } = run(
      filled(),
      order(c('sl'), 'triggered'),
      order(c('tp'), 'canceled'),
      order(c('sl'), 'filled', 0.003),
    );
    expect(commands.filter((cmd) => cmd.type === 'place' || cmd.type === 'modify')).toEqual([]);
    expect(isUnprotected(state)).toBe(false);
    const closed = run(state, sell(0.003, -3.2, c('sl')));
    expect(closed.commands.filter((cmd) => cmd.type === 'place')).toEqual([]);
    expect(closed.state.outcome).toEqual({ kind: 'closed' });
  });

  it('waits for a stop that fills in pieces before placing it again', () => {
    const fired = run(
      filled(),
      order(c('sl'), 'triggered'),
      order(c('sl'), 'filled', 0.002),
      sell(0.001, 0, c('sl')),
    );
    expect(fired.commands.filter((cmd) => cmd.type === 'place')).toEqual([]);
    const rest = run(fired.state, sell(0.001, 0, c('sl')));
    expect(rest.commands).toContainEqual(
      expect.objectContaining({ type: 'place', cloid: c('sl', 1) }),
    );
  });

  it('stops waiting for fills of a fired stop that never come, and protects what is left', () => {
    const fired = run(
      filled(),
      order(c('sl'), 'triggered'),
      order(c('sl'), 'filled', 0.003),
      sell(0.002, 0, c('sl')),
    );
    expect(fired.commands).toContainEqual({ type: 'wait_fills', leg: 'sl', delayMs: 3000 });
    const { commands } = run(fired.state, { type: 'fills_due', leg: 'sl' });
    expect(commands).toContainEqual(expect.objectContaining({ type: 'place', cloid: c('sl', 1) }));
  });

  it('never cuts a later backoff short when a fills timer fires late', () => {
    const replaced = run(
      filled(),
      order(c('sl'), 'triggered'),
      order(c('sl'), 'filled', 0.001),
      sell(0.001, 0, c('sl')),
      order(c('sl', 1), 'open'),
      order(c('sl', 1), 'canceled'),
    ).state;
    const { state, commands } = run(replaced, { type: 'fills_due', leg: 'sl' });
    expect(commands).toEqual([]);
    expect(state.sl.status).toBe('waiting');
  });

  it('reports exposure beyond what the fired stop closes as unprotected', () => {
    const { state } = run(
      resting(),
      buy(0.001),
      order(c('tp'), 'open'),
      order(c('sl'), 'triggered'),
      buy(0.002),
    );
    expect(isUnprotected(state)).toBe(true);
  });

  it('places nothing while a filled take-profit announces its exit before the fill', () => {
    const announced = run(filled(), order(c('tp'), 'filled', 0.003));
    expect(announced.commands).toEqual([{ type: 'wait_fills', leg: 'tp', delayMs: 3000 }]);
    const { commands } = run(announced.state, sell(0.003, 6, c('tp')));
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
  });

  it('closes when HL already pulled the take-profit as reduce-only', () => {
    const { state } = run(
      filled(),
      sell(0.003),
      order(c('tp'), 'canceled'),
      order(c('sl'), 'canceled'),
    );
    expect(state.outcome).toEqual({ kind: 'closed' });
  });

  it('cancels the exits once the market close fills', () => {
    const { commands } = run(filled(), { type: 'close', px: 81_000 }, sell(0.003));
    expect(cancels(commands)).toEqual([
      { type: 'cancel', cloid: c('sl') },
      { type: 'cancel', cloid: c('tp') },
    ]);
  });

  it('cancels a resting entry first, and the stop only once the entry is finished', () => {
    const flat = run(resting(), buy(0.001), order(c('tp'), 'open'), sell(0.001));
    expect(cancels(flat.commands)).toEqual([{ type: 'cancel', cloid: c('entry') }]);
    const done = run(flat.state, order(c('entry'), 'canceled', 0.001));
    expect(cancels(done.commands)).toEqual([
      { type: 'cancel', cloid: c('sl') },
      { type: 'cancel', cloid: c('tp') },
    ]);
  });

  it('protects again when a fill lands while the entry is being cancelled', () => {
    const flat = run(resting(), buy(0.001), order(c('tp'), 'open'), sell(0.001)).state;
    const { state, commands } = run(flat, buy(0.002), order(c('entry'), 'canceled', 0.003));
    expect(cancels(commands)).toEqual([]);
    expect(state.outcome).toBeNull();
    expect(openSize(state)).toBe(0.002);
    expect(isUnprotected(state)).toBe(false);
  });

  it('places the stop again when a fired stop left part of the position open', () => {
    const { state, commands } = run(
      filled(),
      sell(0.001, 0, c('sl')),
      order(c('sl'), 'filled', 0.001),
    );
    expect(state.outcome).toBeNull();
    expect(commands).toContainEqual(expect.objectContaining({ type: 'place', cloid: c('sl', 1) }));
  });

  it('takes a fresh cloid for a second market close after the first was killed', () => {
    const { commands } = run(
      filled(),
      { type: 'close', px: 81_000 },
      order(c('close'), 'canceled', 0),
      { type: 'close', px: 80_900 },
    );
    expect(commands.at(-1)).toMatchObject({ type: 'place', cloid: c('close', 1) });
  });

  it('asks the user when the market close is rejected or never seen', () => {
    for (const event of [rejected(c('close')), { type: 'unknown', cloid: c('close') } as const]) {
      const { state } = run(filled(), { type: 'close', px: 81_000 }, event);
      expect(state.attention).toBe('close_failed');
    }
  });

  it('takes a fresh cloid for a close after a partial close', () => {
    const { commands } = run(
      filled(),
      { type: 'close', px: 81_000 },
      sell(0.001),
      order(c('close'), 'filled', 0.001),
      { type: 'close', px: 80_900 },
    );
    expect(commands.flatMap((cmd) => (cmd.type === 'place' ? [cmd.cloid] : []))).toEqual([
      c('close'),
      c('close', 1),
    ]);
  });

  it('refuses another market close once the close has used every seq, instead of throwing', () => {
    const open = filled();
    const exhausted = { ...open, close: { ...open.close, status: 'done' as const, maxSeq: 255 } };
    const { state, commands } = run(exhausted, { type: 'close', px: 81_000 });
    expect(commands).toEqual([]);
    expect(state.attention).toBe('close_failed');
  });

  it('finishes a cancel whose order the exchange never saw', () => {
    const flat = run(resting(), { type: 'cancel_entry' }, { type: 'unknown', cloid: c('entry') });
    expect(flat.state.entry.status).toBe('done');
  });
});

describe('stop lost mid-bracket', () => {
  const exposed = () => run(working(), buy(0.003), order(c('entry'), 'filled', 0.003)).state;

  it('flags the gap and places the stop again under the next seq after a backoff', () => {
    const lost = run(exposed(), order(c('sl'), 'canceled'));
    expect(lost.commands).toEqual([{ type: 'retry', leg: 'sl', delayMs: 250 }]);
    expect(isUnprotected(lost.state)).toBe(true);
    expect(run(lost.state, { type: 'retry_due', leg: 'sl' }).commands).toEqual([
      {
        type: 'place',
        cloid: c('sl', 1),
        order: { isBuy: false, px: 79_000, size: 0, reduceOnly: true, type: 'stop_market' },
      },
    ]);
  });

  it('keeps sl_failed, and places no stop, when another leg fails after it', () => {
    let failedStop = filled();
    for (let seq = 0; seq < 5; seq++) {
      failedStop = run(
        failedStop,
        order(c('sl', seq), 'canceled'),
        { type: 'retry_due', leg: 'sl' },
        order(c('sl', seq + 1), 'open'),
      ).state;
    }
    expect(failedStop.attention).toBe('sl_failed');
    const killed = run(failedStop, { type: 'close', px: 81_000 }, order(c('close'), 'canceled'));
    expect(killed.state.attention).toBe('sl_failed');
    const exhausted = { ...failedStop, tp: { ...failedStop.tp, maxSeq: 255 } };
    const resized = run(exhausted, sell(0.001));
    expect(resized.state.attention).toBe('sl_failed');
    expect(resized.commands).not.toContainEqual(expect.objectContaining({ type: 'place' }));
  });

  it('counts each external cancel of the stop, then asks the user after five', () => {
    let state = exposed();
    const delays: number[] = [];
    for (let seq = 0; seq < 5; seq++) {
      const step = run(
        state,
        order(c('sl', seq), 'canceled'),
        { type: 'retry_due', leg: 'sl' },
        order(c('sl', seq + 1), 'open'),
      );
      for (const cmd of step.commands) if (cmd.type === 'retry') delays.push(cmd.delayMs);
      state = step.state;
    }
    expect(delays).toEqual([250, 500, 1000, 2000]);
    expect(state.attention).toBe('sl_failed');
  });

  it('starts counting again after a fill, so earlier glitches never strand a later stop', () => {
    let state = exposed();
    for (let seq = 0; seq < 4; seq++) {
      state = run(
        state,
        order(c('sl', seq), 'canceled'),
        { type: 'retry_due', leg: 'sl' },
        order(c('sl', seq + 1), 'open'),
      ).state;
    }
    const { commands } = run(state, sell(0.001), order(c('sl', 4), 'canceled'));
    expect(commands).toContainEqual({ type: 'retry', leg: 'sl', delayMs: 250 });
  });

  it('backs off 250 ms to 2 s, then asks the user after five failures', () => {
    let state = run(exposed(), rejected(c('sl')), { type: 'retry_due', leg: 'sl' }).state;
    const delays: number[] = [];
    for (let seq = 1; seq <= 4; seq++) {
      const step = run(state, rejected(c('sl', seq)), { type: 'retry_due', leg: 'sl' });
      for (const cmd of step.commands) if (cmd.type === 'retry') delays.push(cmd.delayMs);
      state = step.state;
    }
    expect(delays).toEqual([500, 1000, 2000]);
    expect(state.attention).toBe('sl_failed');
    expect(isUnprotected(state)).toBe(true);
  });

  it('sends a cancel again when the order turns out to be still open', () => {
    const { commands } = run(resting(), { type: 'cancel_entry' }, order(c('entry'), 'open'));
    expect(commands).toEqual([
      { type: 'cancel', cloid: c('entry') },
      { type: 'cancel', cloid: c('entry') },
    ]);
  });

  it('pulls a working entry while its stop is missing', () => {
    const { commands } = run(resting(), order(c('sl'), 'canceled'));
    expect(commands).toContainEqual({ type: 'cancel', cloid: c('entry') });
  });

  it('never cancels the stop while a position is open', () => {
    const { commands } = run(exposed(), order(c('tp'), 'open'), buy(0.001), {
      type: 'uncertain',
      cloid: c('tp', 1),
    });
    expect(commands).not.toContainEqual({ type: 'cancel', cloid: c('sl') });
  });

  it('places a stop the exchange never saw under the next seq and cancels the late one', () => {
    const lost = run(
      filled(),
      order(c('sl'), 'canceled'),
      { type: 'retry_due', leg: 'sl' },
      { type: 'uncertain', cloid: c('sl', 1) },
      {
        type: 'unknown',
        cloid: c('sl', 1),
      },
    );
    expect(lost.commands.at(-1)).toEqual({ type: 'retry', leg: 'sl', delayMs: 500 });
    const retried = run(lost.state, { type: 'retry_due', leg: 'sl' });
    expect(retried.commands).toContainEqual(
      expect.objectContaining({ type: 'place', cloid: c('sl', 2) }),
    );
    const late = run(retried.state, {
      type: 'snapshot',
      open: [
        { cloid: c('sl', 1), size: 0 },
        { cloid: c('tp'), size: 0.003 },
      ],
      fills: [],
    });
    expect(late.commands).toContainEqual({ type: 'cancel', cloid: c('sl', 1) });
  });
});

describe('reconstruction', () => {
  it('keeps a resting unfilled entry and its stop across a reload', () => {
    const { state, commands } = run(resting(), {
      type: 'snapshot',
      open: [
        { cloid: c('sl'), size: 0 },
        { cloid: c('entry'), size: 0.003 },
      ],
      fills: [],
    });
    expect(commands).toEqual([]);
    expect(phase(state)).toBe('entry_working');
  });

  it('queries a leg still in flight instead of assuming it is gone', () => {
    const { state, commands } = run(working(), {
      type: 'snapshot',
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(commands).toEqual([{ type: 'query', cloid: c('entry') }]);
    expect(state.cancelling).toBeNull();
  });

  it.each(['sl', 'tp'] as const)(
    'asks for a live %s missing from a snapshot instead of placing a second one',
    (leg) => {
      const open = [
        { cloid: c('sl'), size: 0 },
        { cloid: c('tp'), size: 0.003 },
      ].filter((o) => o.cloid !== c(leg));
      const { state, commands } = run(filled(), { type: 'snapshot', open, fills: [] });
      expect(commands).toEqual([{ type: 'query', cloid: c(leg) }]);
      expect(state[leg]).toMatchObject({ seq: 0, status: 'live' });
    },
  );

  it('rebuilds from the book and fills, cancels a stale leg and resizes the take-profit', () => {
    const first = {
      tid: 900,
      cloid: c('entry'),
      isBuy: true,
      size: 0.001,
      closedPnl: 0,
      fee: 0,
      time: T0,
    };
    const saved = run(resting(), { type: 'fill', ...first }, order(c('tp'), 'open')).state;
    const { state, commands } = run(saved, {
      type: 'snapshot',
      open: [
        { cloid: c('sl'), size: 0 },
        { cloid: c('entry'), size: 0.001 },
        { cloid: c('tp'), size: 0.001 },
        { cloid: c('tp', 7), size: 0.001 },
      ],
      fills: [
        first,
        {
          tid: 901,
          cloid: c('entry'),
          isBuy: true,
          size: 0.001,
          closedPnl: 0,
          fee: 0,
          time: T0 + 1,
        },
      ],
    });
    expect(state.filledSz).toBe(0.002);
    expect(commands).toEqual([
      { type: 'cancel', cloid: c('tp', 7) },
      {
        type: 'modify',
        cloid: c('tp'),
        next: c('tp', 1),
        order: { isBuy: false, px: 82_000, size: 0.002, reduceOnly: true, type: 'alo' },
      },
    ]);
  });

  it('places a missing take-profit for an entry filled while the tab was closed', () => {
    const { commands } = run(resting(), {
      type: 'snapshot',
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [
        { tid: 902, cloid: c('entry'), isBuy: true, size: 0.003, closedPnl: 0, fee: 0, time: T0 },
      ],
    });
    expect(commands).toEqual([
      { type: 'query', cloid: c('entry') },
      {
        type: 'place',
        cloid: c('tp'),
        order: { isBuy: false, px: 82_000, size: 0.003, reduceOnly: true, type: 'alo' },
      },
    ]);
  });

  it('places the stop again when the book lost it while a position is open', () => {
    const lost = run(
      filled(),
      { type: 'snapshot', open: [{ cloid: c('tp'), size: 0.003 }], fills: [] },
      order(c('sl'), 'canceled'),
    );
    expect(lost.commands).toEqual([
      { type: 'query', cloid: c('sl') },
      { type: 'retry', leg: 'sl', delayMs: 250 },
    ]);
    const { commands } = run(lost.state, { type: 'retry_due', leg: 'sl' });
    expect(commands[0]).toMatchObject({ type: 'place', cloid: c('sl', 1) });
  });

  it('does not send an entry that was never sent before the reload', () => {
    const halfway = run(openBracket(PLAN).state, order(c('sl'), 'open')).state;
    const reloaded = { ...halfway, entry: { ...halfway.entry, status: 'idle' as const } };
    const { commands } = run(reloaded, {
      type: 'snapshot',
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
  });

  it('keeps the take-profit a modify is replacing until the modify resolves', () => {
    const modifying = run(resting(), buy(0.001), order(c('tp'), 'open'), buy(0.001)).state;
    const { commands } = run(modifying, {
      type: 'snapshot',
      open: [
        { cloid: c('sl'), size: 0 },
        { cloid: c('entry'), size: 0.001 },
        { cloid: c('tp'), size: 0.001 },
      ],
      fills: [],
    });
    expect(commands).toEqual([{ type: 'query', cloid: c('tp', 1) }]);
  });

  it('keeps the stop of an unknown entry across a reload until the user dismisses', () => {
    const lost = run(
      working(),
      { type: 'uncertain', cloid: c('entry') },
      { type: 'unknown', cloid: c('entry') },
    );
    const reloaded = run(lost.state, {
      type: 'snapshot',
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(reloaded.commands).toEqual([]);
    expect(reloaded.state.attention).toBe('entry_unknown');
  });
  it('asks for the fate of a fired stop whose fills did not come before the reload', () => {
    const fired = run(filled(), order(c('sl'), 'triggered')).state;
    const { commands } = run(fired, { type: 'snapshot', open: [], fills: [] });
    expect(commands).toEqual([
      { type: 'query', cloid: c('sl') },
      { type: 'query', cloid: c('tp') },
    ]);
  });

  it('drops entry_unknown once a snapshot finds the entry resting, so dismiss no longer applies', () => {
    const lost = run(
      working(),
      { type: 'uncertain', cloid: c('entry') },
      { type: 'unknown', cloid: c('entry') },
    ).state;
    const found = run(lost, {
      type: 'snapshot',
      open: [
        { cloid: c('sl'), size: 0 },
        { cloid: c('entry'), size: 0.003 },
      ],
      fills: [],
    }).state;
    expect(found.attention).toBeNull();
    expect(run(found, { type: 'dismiss' }).commands).toEqual([]);
  });

  it('winds down a working entry before its stop', () => {
    const { commands } = run(
      { ...resting(), cancelling: 'dismissed' },
      { type: 'retry_due', leg: 'tp' },
    );
    expect(commands).toEqual([{ type: 'cancel', cloid: c('entry') }]);
  });
});

describe('lifecycle', () => {
  it('ignores events once the bracket is over', () => {
    const over = run(working(), order(c('entry'), 'canceled', 0), order(c('sl'), 'canceled')).state;
    expect(reduceBracket(over, buy(0.003))).toEqual({ state: over, commands: [] });
  });

  it('ignores user choices that do not apply', () => {
    for (const event of [
      { type: 'tp_at', px: 1 },
      { type: 'sl_only' },
      { type: 'dismiss' },
      { type: 'cancel_entry' },
    ] as const) {
      expect(run(filled(), event).commands).toEqual([]);
    }
  });
});
