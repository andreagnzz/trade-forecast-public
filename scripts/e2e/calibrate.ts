import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { E2E_PREFIX, makeCloid } from '../../src/core/bracket/cloid';
import { randomBracketId } from '../../src/services/bracketManager';
import { COIN, flatten, market, orders, reads } from './harness';

// Opens and closes a known trade to pin down whether closedPnl includes the fee.
export async function calibrate() {
  await flatten(COIN);
  const id = randomBracketId();
  const since = (await reads.position(COIN)).time;
  const open = await market(COIN);
  const size = open.sizeForUsd(15);
  await orders.send(COIN, {
    type: 'place',
    cloid: makeCloid(E2E_PREFIX, id, 'entry', 0),
    order: {
      isBuy: true,
      px: open.px(open.ask * 1.002),
      size,
      reduceOnly: false,
      type: 'ioc',
    },
  });
  await sleep(1000);
  const close = await market(COIN);
  await orders.send(COIN, {
    type: 'place',
    cloid: makeCloid(E2E_PREFIX, id, 'close', 0),
    order: {
      isBuy: false,
      px: close.px(close.bid * 0.998),
      size,
      reduceOnly: true,
      type: 'ioc',
    },
  });
  await sleep(2000);
  const fills = (await reads.fills(since))
    .filter((f) => f.cloid?.includes(id))
    .map(({ side, px, sz, startPosition, closedPnl, fee }) => ({
      side,
      px,
      sz,
      startPosition,
      closedPnl,
      fee,
    }));
  await writeFile(
    'test-results/closedpnl-calibration.json',
    `${JSON.stringify({ coin: COIN, fills }, null, 2)}\n`,
  );
  const bought = fills.filter((f) => f.side === 'buy');
  const entryPx =
    bought.reduce((sum, f) => sum + f.px * f.sz, 0) / bought.reduce((sum, f) => sum + f.sz, 0);
  for (const f of fills.filter((x) => x.side === 'sell')) {
    const gross = (f.px - entryPx) * f.sz;
    console.log(
      `calibration: closedPnl ${String(f.closedPnl)}, (exit - entry) * sz ${gross.toFixed(6)}, fee ${String(f.fee)}`,
    );
  }
}
