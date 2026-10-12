import type { BracketCommand } from '../core/bracket/bracket';
import { preTradeCheck, type OrderIntent } from '../core/preTradeCheck';
import type { DayStats, RulesState } from '../core/rules';
import type { ExecutionClient } from '../hl/exchange';
import type { OrderResult } from '../hl/orders';

type OrderCommand = Extract<BracketCommand, { type: 'place' | 'modify' | 'cancel' }>;

// unavailable: today's stats could not be read, so nothing exposure-increasing goes out.
export type SendResult =
  | OrderResult
  | { status: 'blocked'; reasons: ReturnType<typeof preTradeCheck>['reasons'] }
  | { status: 'unavailable' };

interface OrderServiceDeps {
  client: Pick<ExecutionClient, 'place' | 'modify' | 'cancel'>;
  rules: { load: () => RulesState; save: (state: RulesState) => void };
  stats: () => Promise<DayStats>;
  now: () => number;
}

function intentOf(command: OrderCommand): OrderIntent {
  if (command.type === 'cancel') return { kind: 'cancel' };
  return { kind: command.type, reduceOnly: command.order.reduceOnly };
}

const protective = (intent: OrderIntent) => intent.kind === 'cancel' || intent.reduceOnly;

// The single gate before signing: every order of the app and of the e2e script passes here.
// Protective orders go straight out; exposure is checked against freshly read day stats, so a
// loss that just closed counts even if the screen has not caught up.
export function createOrderService({ client, rules, stats, now }: OrderServiceDeps) {
  // null when the stats cannot be read: the gate fails closed rather than guess.
  async function check(intent: OrderIntent) {
    let day: DayStats;
    try {
      day = await stats();
    } catch {
      return null;
    }
    const verdict = preTradeCheck(intent, rules.load(), day, now());
    rules.save(verdict.state);
    return verdict;
  }

  async function send(coin: string, command: OrderCommand): Promise<SendResult> {
    const intent = intentOf(command);
    if (!protective(intent)) {
      const verdict = await check(intent);
      if (!verdict) return { status: 'unavailable' };
      if (verdict.verdict === 'block') return { status: 'blocked', reasons: verdict.reasons };
    }
    switch (command.type) {
      case 'place':
        return client.place(coin, command.cloid, command.order);
      case 'modify':
        return client.modify(coin, command.cloid, command.next, command.order);
      case 'cancel':
        return client.cancel(coin, command.cloid);
    }
  }

  return { check, send };
}

export type OrderService = ReturnType<typeof createOrderService>;
