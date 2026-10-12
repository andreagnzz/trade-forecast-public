import { describe, expect, it } from 'vitest';
import { isUnprotected, openBracket, openSize, phase } from './bracket';
import {
  PLAN,
  IOC,
  c,
  buy,
  sell,
  order,
  rejected,
  run,
  working,
  resting,
  filled,
} from './fixtures';
import { reduceBracket } from './reduce';

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
  });

  it('leaves the stop resting on dismiss, in case the unknown entry lands late', () => {
    const lost = run(working(), { type: 'unknown', cloid: c('entry') }).state;
    const { state, commands } = run(lost, { type: 'dismiss' });
    expect(commands).toEqual([]);
    expect(state.outcome).toEqual({ kind: 'cancelled', reason: 'dismissed' });
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
