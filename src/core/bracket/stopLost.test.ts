import { describe, expect, it } from 'vitest';
import { isUnprotected, openBracket } from './bracket';
import { PLAN, c, buy, sell, order, rejected, run, working, resting, filled } from './fixtures';

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
      reload: true,
      open: [
        { cloid: c('sl', 1), size: 0 },
        { cloid: c('tp'), size: 0.003 },
      ],
      fills: [],
    });
    expect(late.commands).toContainEqual({ type: 'cancel', cloid: c('sl', 1) });
  });

  it('cancels a lost stop that lands after its replacement was sent', () => {
    const lost = run(
      openBracket(PLAN).state,
      { type: 'uncertain', cloid: c('sl') },
      { type: 'unknown', cloid: c('sl') },
      { type: 'retry_due', leg: 'sl' },
    ).state;
    const { state, commands } = run(lost, order(c('sl'), 'open'));
    expect(commands).toEqual([{ type: 'cancel', cloid: c('sl') }]);
    expect(state.sl.seq).toBe(1);
  });
});
