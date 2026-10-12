import {
  exitOrder,
  isTpAttention,
  legCloid,
  type Bracket,
  type BracketCommand,
  type BracketEvent,
} from './bracket';
import { replace } from './legs';

export type UserEvent = Extract<
  BracketEvent,
  { type: 'cancel_entry' | 'sl_only' | 'dismiss' | 'close' | 'tp_at' }
>;

const validPx = (px: number) => Number.isFinite(px) && px > 0;

export function applyChoice(d: Bracket, event: UserEvent): BracketCommand[] {
  const tpAttention = isTpAttention(d.attention);
  switch (event.type) {
    case 'cancel_entry':
      if (d.entry.status !== 'live') return [];
      d.entry.status = 'canceling';
      return [{ type: 'cancel', cloid: legCloid(d, 'entry') }];
    case 'close': {
      const order = exitOrder(d, event.px, 'ioc');
      // A close waiting for its fills would be sized on a position it already closed.
      const busy = d.close.status === 'sending' || d.close.status === 'filling';
      if (!validPx(event.px) || order.size <= 0 || busy) return [];
      // Any close sent before used its cloid, even one still waiting for its fills.
      if (d.close.status !== 'idle' && !replace(d, 'close')) return [];
      d.close.status = 'sending';
      if (d.attention !== 'sl_failed') d.attention = null;
      return [{ type: 'place', cloid: legCloid(d, 'close'), order }];
    }
    case 'tp_at':
      if (!tpAttention || !validPx(event.px)) return [];
      Object.assign(d.tp, { px: event.px, retries: 0 });
      d.attention = null;
      if (d.tp.status === 'done') replace(d, 'tp');
      return [];
    case 'sl_only':
      if (!tpAttention) return [];
      d.tp.px = null;
      d.attention = null;
      if (d.tp.status !== 'live') return [];
      d.tp.status = 'canceling';
      return [{ type: 'cancel', cloid: legCloid(d, 'tp') }];
    case 'dismiss':
      // The stop stays behind for a late entry, so it must be resting first.
      if (d.attention !== 'entry_unknown' || d.filledSz > 0 || d.sl.status !== 'live') return [];
      d.attention = null;
      d.cancelling ??= 'dismissed';
      return [];
  }
}
