import {
  openBracket,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
  type BracketPlan,
  type RejectReason,
} from './bracket';
import { APP_PREFIX, makeCloid, parseCloid, type LegName } from './cloid';
import { reduceBracket } from './reduce';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
export const T0 = Date.UTC(2026, 9, 12, 10);

export const PLAN: BracketPlan = {
  id: ID,
  prefix: APP_PREFIX,
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

export const IOC: BracketPlan = { ...PLAN, entry: { type: 'ioc', px: 80_100 } };

export const c = (leg: LegName, seq = 0) => makeCloid(APP_PREFIX, ID, leg, seq);

let tid = 1;
const fill = (isBuy: boolean, size: number, pnl: number, cloid: string | null) =>
  ({ type: 'fill', tid: tid++, cloid, isBuy, size, closedPnl: pnl, fee: 0, time: T0 }) as const;
export const buy = (size: number) => fill(true, size, 0, c('entry'));
export const sell = (size: number, pnl = 0, cloid: string | null = null) =>
  fill(false, size, pnl, cloid);
export const order = (
  cloid: string,
  status: 'open' | 'filled' | 'canceled' | 'triggered',
  filledSz = 0,
) => ({ type: 'order', cloid, status, filledSz }) as const;
export const rejected = (cloid: string, reason: RejectReason = 'other') =>
  ({ type: 'rejected', cloid, reason }) as const;

export function run(start: Bracket, ...events: BracketEvent[]) {
  let state = start;
  const commands: BracketCommand[] = [];
  for (const event of events) {
    const step = reduceBracket(state, event);
    state = step.state;
    commands.push(...step.commands);
  }
  return { state, commands };
}

export const cancels = (commands: BracketCommand[]) =>
  commands.filter((cmd) => cmd.type === 'cancel');
export const legOf = (cmd: BracketCommand) =>
  'cloid' in cmd ? parseCloid(cmd.cloid)?.leg : cmd.leg;

// The position stop rests and the entry is sent.
export const working = (plan: BracketPlan = PLAN) =>
  run(openBracket(plan).state, order(c('sl'), 'open')).state;
// The entry rests on the book too.
export const resting = () => run(working(), order(c('entry'), 'open')).state;
// Fully filled with the take-profit resting.
export const filled = () =>
  run(working(), buy(0.003), order(c('entry'), 'filled', 0.003), order(c('tp'), 'open')).state;
