import { setTimeout as sleep } from 'node:timers/promises';
import { openSize, phase, type BracketPlan } from '../../src/core/bracket/bracket';
import { makeCloid } from '../../src/core/bracket/cloid';
import { changeRules, initialRulesState } from '../../src/core/rules';
import { loadAsks } from '../../src/hl/marketData';
import { randomBracketId } from '../../src/services/bracketManager';
import {
  appOrders,
  closePx,
  dayStats,
  longPlan,
  market,
  openSession,
  orders,
  reads,
  rules,
  waitFor,
} from './harness';

export const COIN = 'BTC';
const THIN_COINS = ['AVAX', 'SOL', 'ARB', 'SUI', 'DOGE', 'ETH'];

export interface Run {
  scenario: string;
  ok: boolean;
  note: string;
  slAheadOfFillMs?: number;
  fillToTpMs?: number;
}

type Session = ReturnType<typeof openSession>;

async function closeAndCheck(session: Session, coin: string) {
  const bracket = session.view().bracket;
  if (!bracket) throw new Error('no bracket');
  if (!bracket.outcome) {
    session.manager.choose({ type: 'close', px: await closePx(coin, false) });
    await waitFor('closed', () => !!session.view().bracket?.outcome);
  }
  await sleep(1500);
  const left = await appOrders(bracket.plan.id);
  const position = await reads.position(coin);
  if (left.length > 0) throw new Error(`legs left: ${String(left.length)}`);
  if (position.size !== 0) throw new Error(`position left: ${String(position.size)}`);
}

const send = async (session: Session, plan: BracketPlan) =>
  session.manager.send(plan, (await market(plan.coin)).markPx);

async function protectedMarketBracket(options: { tpPx?: number; stopPx?: number } = {}) {
  const session = openSession();
  const plan = await longPlan(COIN, { type: 'ioc', ...options });
  const refusal = await send(session, plan);
  if (refusal) throw new Error(`send refused: ${refusal}`);
  return { session, plan };
}

// A timeout says where the bracket stopped, not only that it stopped.
async function waitPhase(session: Session, wanted: string, ms?: number) {
  await waitFor(
    wanted,
    () => {
      const b = session.view().bracket;
      return !!b && phase(b) === wanted;
    },
    ms,
  ).catch((error: unknown) => {
    const b = session.view().bracket;
    const state = b && {
      phase: phase(b),
      entry: b.entry,
      sl: b.sl,
      tp: b.tp,
      filledSz: b.filledSz,
      exitedSz: b.exitedSz,
      attention: b.attention,
      lastError: session.view().lastError,
    };
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(state)}`,
    );
  });
}

const timing = (session: Session) => ({
  slAheadOfFillMs: (session.marks.filled ?? Number.NaN) - (session.marks.slLive ?? Number.NaN),
  fillToTpMs: (session.marks.tpLive ?? Number.NaN) - (session.marks.filled ?? Number.NaN),
});

export const scenarios: Record<string, () => Promise<Omit<Run, 'scenario' | 'ok'>>> = {
  async a() {
    const { session } = await protectedMarketBracket();
    await waitPhase(session, 'protected');
    const { tp, filledSz } = session.view().bracket ?? noBracket();
    if (tp.size !== filledSz)
      throw new Error(`tp ${String(tp.size)} != filled ${String(filledSz)}`);
    const times = timing(session);
    await closeAndCheck(session, COIN);
    session.dispose();
    return { note: `filled ${String(filledSz)}`, ...times };
  },

  async c() {
    const m = await market(COIN);
    const { session } = await protectedMarketBracket({ tpPx: m.px(m.bid * 0.999) });
    await waitFor('tp_would_cross', () => session.view().bracket?.attention === 'tp_would_cross');
    const error = session.view().lastError;
    session.manager.choose({ type: 'sl_only' });
    await waitPhase(session, 'protected');
    await closeAndCheck(session, COIN);
    session.dispose();
    return { note: error ?? '' };
  },

  async d() {
    const { session, plan } = await protectedMarketBracket();
    await waitPhase(session, 'protected');
    const outside = makeCloid('7465', randomBracketId(), 'close', 0);
    const size = openSize(session.view().bracket ?? noBracket());
    await orders.send(COIN, {
      type: 'place',
      cloid: outside,
      order: {
        isBuy: false,
        px: await closePx(COIN, false),
        size,
        reduceOnly: true,
        type: 'ioc',
      },
    });
    await waitFor('closed', () => session.view().bracket?.outcome?.kind === 'closed');
    await closeAndCheck(session, COIN);
    session.dispose();
    return { note: `closed outside the bracket, legs of ${plan.id.slice(0, 6)} cancelled` };
  },

  async e() {
    const { session, plan } = await protectedMarketBracket();
    await waitPhase(session, 'protected');
    const before = (await appOrders(plan.id)).map((o) => o.cloid).sort();
    session.dispose();
    const reloaded = openSession(session.storage);
    const started = Date.now();
    await reloaded.manager.load();
    await reloaded.manager.settled();
    const rebuiltMs = Date.now() - started;
    await sleep(2000);
    const after = (await appOrders(plan.id)).map((o) => o.cloid).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`book changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    if (phase(reloaded.view().bracket ?? noBracket()) !== 'protected')
      throw new Error('not protected');
    await closeAndCheck(reloaded, COIN);
    reloaded.dispose();
    return {
      note: `rebuilt in ${String(rebuiltMs)} ms, ${String(after.length)} legs, no duplicate`,
    };
  },

  async f() {
    const stats = await dayStats();
    const armed = changeRules(initialRulesState, { oneBullet: true }, Date.now());
    if (!armed.ok) throw new Error(armed.error);
    rules.state = armed.state;
    if (!stats.trips.some((t) => t.netPnl < 0)) throw new Error('no losing round-trip today');
    const session = openSession();
    const refusal = await send(session, await longPlan(COIN, { type: 'ioc' }));
    const plan = await longPlan(COIN, { type: 'ioc' });
    const direct = await orders.send(COIN, {
      type: 'place',
      cloid: makeCloid('7465', plan.id, 'entry', 0),
      order: { isBuy: true, px: plan.entry.px, size: plan.size, reduceOnly: false, type: 'ioc' },
    });
    const cancel = await orders.send(COIN, {
      type: 'cancel',
      cloid: makeCloid('7465', randomBracketId(), 'tp', 0),
    });
    const lock = rules.state.lock?.reason ?? 'none';
    rules.state = initialRulesState;
    session.dispose();
    if (refusal !== 'blocked' || direct.status !== 'blocked') throw new Error('not blocked');
    if (cancel.status === 'blocked') throw new Error('cancel blocked');
    if ((await appOrders(plan.id)).length > 0) throw new Error('an order reached the book');
    return {
      note: `lock ${lock}, entry blocked before signing, cancel reached HL (${cancel.status})`,
    };
  },

  async b() {
    const thin = await thinBook();
    const session = openSession();
    const plan = await longPlan(thin.coin, {
      type: 'gtc',
      entryPx: thin.topPx,
      usd: thin.topNotional * 2,
    });
    const refusal = await send(session, plan);
    if (refusal) throw new Error(`send refused: ${refusal}`);
    await waitFor('partial fill', () => (session.view().bracket?.filledSz ?? 0) > 0);
    session.manager.choose({ type: 'cancel_entry' });
    await waitFor('entry done', () => session.view().bracket?.entry.status === 'done');
    await waitFor('tp at filled size', () => {
      const b = session.view().bracket;
      return !!b && (phase(b) === 'protected' || b.attention === 'tp_below_min');
    });
    const b = session.view().bracket ?? noBracket();
    const note = `${thin.coin} filled ${String(b.filledSz)}/${String(plan.size)}, tp ${String(b.tp.size)}${b.attention ? ` (${b.attention})` : ''}`;
    if (b.attention === null && b.tp.size !== b.filledSz) throw new Error(note);
    if (b.attention) session.manager.choose({ type: 'sl_only' });
    await closeAndCheck(session, thin.coin);
    session.dispose();
    return { note };
  },

  // A real stop a few ticks under the mark, left to the market: best effort by nature.
  async g() {
    const m = await market(COIN);
    const { session } = await protectedMarketBracket({ stopPx: m.px(m.markPx * 0.9999) });
    await waitFor('stop fired', () => !!session.view().bracket?.outcome, 180_000);
    const b = session.view().bracket ?? noBracket();
    if (b.outcome?.kind !== 'closed') throw new Error(`outcome ${JSON.stringify(b.outcome)}`);
    await closeAndCheck(session, COIN);
    session.dispose();
    return { note: `closed by the stop, pnl ${b.pnlUsd.toFixed(4)}`, ...timing(session) };
  },
};

function noBracket(): never {
  throw new Error('no bracket');
}

// A book whose best ask is small enough to fill only part of a resting buy at that price.
async function thinBook() {
  for (const coin of THIN_COINS) {
    const [top, next] = await loadAsks(coin, 'testnet', 2);
    if (!top || !next) continue;
    const topNotional = top.px * top.sz;
    if (topNotional >= 12 && topNotional <= 200 && next.px > top.px) {
      return { coin, topPx: top.px, topNotional };
    }
  }
  throw new Error('no thin book');
}
