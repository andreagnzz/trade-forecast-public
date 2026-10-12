import { describe, expect, it } from 'vitest';
import type { OrderSpec } from '../core/bracket/bracket';
import { errorFromStatus, parseHlError, rejectionText } from './errors';
import { placeResult, statusView, toWireOrder } from './orders';

const CLOID = '0x74656045b371a979b3be778ce00b0200';
const STOP: OrderSpec = {
  isBuy: false,
  px: 80_275.4,
  size: 0,
  reduceOnly: true,
  type: 'stop_market',
};
const TP: OrderSpec = { isBuy: false, px: 85_241, size: 0.00019, reduceOnly: true, type: 'alo' };
const GTC: OrderSpec = { isBuy: true, px: 26.5, size: 43.57, reduceOnly: false, type: 'gtc' };
const IOC: OrderSpec = { ...GTC, type: 'ioc' };

describe('wire orders', () => {
  it('sends the position stop as a sizeless market trigger', () => {
    expect(toWireOrder(3, 5, CLOID, STOP)).toEqual({
      a: 3,
      b: false,
      p: '80275',
      s: '0',
      r: true,
      t: { trigger: { isMarket: true, triggerPx: '80275', tpsl: 'sl' } },
      c: CLOID,
    });
  });

  it('sends the take-profit as a post-only reduce-only limit', () => {
    expect(toWireOrder(3, 5, CLOID, TP)).toMatchObject({
      p: '85241',
      s: '0.00019',
      r: true,
      t: { limit: { tif: 'Alo' } },
    });
  });
});

describe('place response', () => {
  it.each([
    {
      name: 'a resting order',
      status: { resting: { oid: 1 } },
      spec: TP,
      expected: { status: 'resting' },
    },
    {
      name: 'a waiting trigger',
      status: 'waitingForTrigger' as const,
      spec: STOP,
      expected: { status: 'resting' },
    },
    {
      name: 'an IOC that filled in part',
      status: { filled: { totalSz: '21.56' } },
      spec: IOC,
      expected: { status: 'filled', filledSz: 21.56 },
    },
    {
      name: 'a GTC that filled in part and keeps resting',
      status: { filled: { totalSz: '24.21' } },
      spec: GTC,
      expected: { status: 'resting' },
    },
    {
      name: 'a GTC that filled entirely',
      status: { filled: { totalSz: '43.57' } },
      spec: GTC,
      expected: { status: 'filled', filledSz: 43.57 },
    },
    { name: 'a missing status', status: undefined, spec: GTC, expected: { status: 'uncertain' } },
  ])('maps $name', ({ status, spec, expected }) => {
    expect(placeResult(status, spec)).toEqual(expected);
  });

  it('maps a crossing post-only to BadAloPx', () => {
    const error = 'Post only order would have immediately matched, bbo was 82865@82866. asset=3';
    expect(placeResult({ error }, TP)).toEqual({
      status: 'rejected',
      error: { code: 'BadAloPx', message: error },
    });
  });
});

describe('errors', () => {
  it.each([
    ['Order must have minimum value of $10. asset=3', 'MinTradeNtl'],
    ['Order was never placed, already canceled, or filled. asset=3', 'MissingOrder'],
    ['Reduce only order would increase position. asset=0', 'ReduceOnly'],
    ['Cannot modify canceled or filled order', 'ModifyGone'],
    ['something new', 'Unknown'],
  ])('reads %s as %s', (message, code) => {
    expect(parseHlError(message).code).toBe(code);
  });

  it.each([
    ['badAloPxRejected', 'BadAloPx'],
    ['minTradeNtlRejected', 'MinTradeNtl'],
    ['iocCancelRejected', 'IocCancel'],
    ['tooManyOpenOrdersRejected', 'Unknown'],
  ])('reads the %s status as %s', (status, code) => {
    expect(errorFromStatus(status).code).toBe(code);
  });

  it('finds the error text in both API error shapes', () => {
    const order = {
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ error: 'Invalid TP/SL price. asset=3' }] } },
    };
    expect(rejectionText(order)).toBe('Invalid TP/SL price. asset=3');
    expect(rejectionText({ status: 'err', response: 'User or API Wallet does not exist' })).toBe(
      'User or API Wallet does not exist',
    );
    expect(rejectionText(null)).toBe('');
  });
});

describe('order status', () => {
  it.each([
    ['open', 'open'],
    ['triggered', 'triggered'],
    ['reduceOnlyCanceled', 'canceled'],
    ['siblingFilledCanceled', 'canceled'],
    ['scheduledCancel', 'canceled'],
    ['badAloPxRejected', 'rejected'],
  ])('buckets %s as %s', (status, state) => {
    expect(statusView({ origSz: '1', sz: '1' }, status, 0).state).toBe(state);
  });

  it('reads the filled size of a finished order as origSz minus sz', () => {
    expect(statusView({ origSz: '0.00019', sz: '0.0' }, 'filled', 5)).toEqual({
      state: 'filled',
      filledSz: 0.00019,
    });
    expect(statusView({ origSz: '43.57', sz: '19.36' }, 'canceled', 2)).toEqual({
      state: 'canceled',
      filledSz: 24.21,
    });
    expect(statusView({ origSz: '1', sz: '1' }, 'badAloPxRejected', 0)).toEqual({
      state: 'rejected',
      error: { code: 'BadAloPx', message: 'badAloPxRejected' },
    });
  });
});
