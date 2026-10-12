import { describe, expect, it } from 'vitest';
import { isUnprotected, openBracket, phase } from './bracket';
import { PLAN, T0, buy, c, cancels, filled, order, resting, run, working } from './fixtures';

describe('reconstruction', () => {
  it('keeps a resting unfilled entry and its stop across a reload', () => {
    const { state, commands } = run(resting(), {
      type: 'snapshot',
      reload: true,
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
      reload: true,
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
      const { state, commands } = run(filled(), {
        type: 'snapshot',
        reload: true,
        open,
        fills: [],
      });
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
      reload: true,
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
      reload: true,
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
      { type: 'snapshot', reload: true, open: [{ cloid: c('tp'), size: 0.003 }], fills: [] },
      order(c('sl'), 'canceled'),
    );
    expect(lost.commands).toEqual([
      { type: 'query', cloid: c('sl') },
      { type: 'retry', leg: 'sl', delayMs: 250 },
    ]);
    const { commands } = run(lost.state, { type: 'retry_due', leg: 'sl' });
    expect(commands[0]).toMatchObject({ type: 'place', cloid: c('sl', 1) });
  });

  it('keeps a fresh bracket and its retry timer on a resync of the same page', () => {
    const sending = run(
      openBracket(PLAN).state,
      { type: 'uncertain', cloid: c('sl') },
      { type: 'unknown', cloid: c('sl') },
    );
    const { state, commands } = run(sending.state, {
      type: 'snapshot',
      reload: false,
      open: [],
      fills: [],
    });
    expect(commands).toEqual([]);
    expect(state.cancelling).toBeNull();
    expect(state.sl.status).toBe('waiting');
    expect(state.entry.status).toBe('idle');
  });

  it('does not send an entry that was never sent before the reload', () => {
    const halfway = run(openBracket(PLAN).state, order(c('sl'), 'open')).state;
    const reloaded = { ...halfway, entry: { ...halfway.entry, status: 'idle' as const } };
    const { commands } = run(reloaded, {
      type: 'snapshot',
      reload: true,
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
  });

  it('keeps the take-profit a modify is replacing until the modify resolves', () => {
    const modifying = run(resting(), buy(0.001), order(c('tp'), 'open'), buy(0.001)).state;
    const { commands } = run(modifying, {
      type: 'snapshot',
      reload: true,
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
      reload: true,
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(reloaded.commands).toEqual([]);
    expect(reloaded.state.attention).toBe('entry_unknown');
  });
  it('asks for the fate of a fired stop whose fills did not come before the reload', () => {
    const fired = run(filled(), order(c('sl'), 'triggered')).state;
    const { commands } = run(fired, { type: 'snapshot', reload: true, open: [], fills: [] });
    expect(commands).toEqual([
      { type: 'query', cloid: c('sl') },
      { type: 'wait_fills', leg: 'sl', seq: 0, delayMs: 3000 },
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
      reload: true,
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

describe('resync while requests are in flight', () => {
  it('leaves an entry being cancelled to its cancel answer, so the stop stays', () => {
    const cancelling = run(resting(), { type: 'cancel_entry' }).state;
    const { state, commands } = run(cancelling, {
      type: 'snapshot',
      reload: false,
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(cancels(commands)).toEqual([]);
    const landed = run(state, order(c('entry'), 'filled', 0.003), buy(0.003)).state;
    expect(isUnprotected(landed)).toBe(false);
  });

  it('asks after a reload what became of an entry being cancelled', () => {
    const cancelling = run(resting(), { type: 'cancel_entry' }).state;
    const { commands } = run(cancelling, {
      type: 'snapshot',
      reload: true,
      open: [{ cloid: c('sl'), size: 0 }],
      fills: [],
    });
    expect(commands).toEqual([{ type: 'query', cloid: c('entry') }]);
  });

  it('restarts the fills timer of a fired stop after a reload', () => {
    const fired = run(filled(), order(c('sl'), 'triggered')).state;
    const reloaded = run(
      fired,
      { type: 'snapshot', reload: true, open: [], fills: [] },
      order(c('sl'), 'filled', 0.001),
    );
    expect(reloaded.commands).toContainEqual({
      type: 'wait_fills',
      leg: 'sl',
      seq: 0,
      delayMs: 3000,
    });
    const { commands } = run(reloaded.state, { type: 'fills_due', leg: 'sl', seq: 0 });
    expect(commands).toContainEqual(expect.objectContaining({ type: 'place', cloid: c('sl', 1) }));
  });

  it('places the stop again when the exchange has no record of a live one', () => {
    const missing = run(
      filled(),
      { type: 'snapshot', reload: false, open: [{ cloid: c('tp'), size: 0.003 }], fills: [] },
      { type: 'unknown', cloid: c('sl') },
    );
    expect(missing.commands).toContainEqual({ type: 'retry', leg: 'sl', delayMs: 250 });
  });

  it('holds the take-profit when fills show a stop missing from the book has fired', () => {
    const stopFill = {
      tid: 900,
      cloid: c('sl'),
      isBuy: false,
      size: 0.002,
      closedPnl: 0,
      fee: 0,
      time: T0,
    };
    const { commands } = run(filled(), {
      type: 'snapshot',
      reload: false,
      open: [],
      fills: [stopFill],
    });
    expect(commands.filter((cmd) => cmd.type === 'place' || cmd.type === 'modify')).toEqual([]);
  });
});
