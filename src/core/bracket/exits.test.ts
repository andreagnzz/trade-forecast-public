import { describe, expect, it } from 'vitest';
import { isUnprotected, openSize, phase, rMultiple, type BracketEvent } from './bracket';
import {
  c,
  buy,
  sell,
  order,
  rejected,
  run,
  cancels,
  legOf,
  working,
  resting,
  filled,
} from './fixtures';

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

  it('places no take-profit while a filled market close waits for its fills', () => {
    const sent = run(working(), buy(0.003), order(c('entry'), 'filled', 0.003), rejected(c('tp')), {
      type: 'close',
      px: 81_000,
    }).state;
    const closing = run(sent, { type: 'retry_due', leg: 'tp' }, order(c('close'), 'filled', 0.003));
    expect(closing.commands.filter((cmd) => legOf(cmd) === 'tp')).toEqual([]);
    expect(closing.commands).toContainEqual({ type: 'wait_fills', leg: 'close', delayMs: 3000 });
    const { state } = run(closing.state, sell(0.003, 0, c('close')), order(c('sl'), 'canceled'));
    expect(state.outcome).toEqual({ kind: 'closed' });
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
