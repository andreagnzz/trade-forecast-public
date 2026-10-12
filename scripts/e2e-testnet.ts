import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { messageOf } from '../src/hl/errors';
import { calibrate } from './e2e/calibrate';
import { COIN, disposeSessions, flatten, median } from './e2e/harness';
import { scenarios, THIN_COINS, type Run } from './e2e/scenarios';

const DEFAULT_RUNS: [string, number][] = [
  ['marketBracket', 10],
  ['crossingTp', 10],
  ['outsideClose', 10],
  ['reload', 10],
  ['oneBullet', 10],
  ['partialFill', 4],
  ['stopHit', 4],
];

// `pnpm e2e:testnet marketBracket:1 crossingTp:2` runs a subset, `calibrate` re-measures
// closedPnl; no argument runs the full set.
const args = process.argv.slice(2);
if (args.includes('calibrate')) await calibrate();
const requested = args
  .filter((arg) => arg !== 'calibrate')
  .map((arg): [string, number] => {
    const [name = '', count = '1'] = arg.split(':');
    return [name, Number(count)];
  });
const PLAN = requested.length > 0 ? requested : DEFAULT_RUNS;
// A failed run must not take the rest down. Its session's retry timers run out within the first
// wait; a rate limit gets a minute to cool off, then one more try. If cleanup still fails, the
// next scenario's busy-coin check says so.
async function cleanUp() {
  disposeSessions();
  for (const wait of [10_000, 60_000]) {
    await sleep(wait);
    try {
      for (const coin of [COIN, ...THIN_COINS]) await flatten(coin);
      return;
    } catch (error) {
      console.log(`  cleanup failed: ${messageOf(error)}`);
    }
  }
}

// Leftovers of an earlier interrupted run would make every send refuse a busy coin.
for (const coin of [COIN, ...THIN_COINS]) await flatten(coin);

const runs: Run[] = [];
for (const [scenario, count] of PLAN) {
  for (let i = 0; i < count; i++) {
    let run: Run;
    try {
      const play = scenarios[scenario];
      if (!play) throw new Error(`unknown scenario: ${scenario}`);
      run = { scenario, ok: true, ...(await play()) };
    } catch (error) {
      run = { scenario, ok: false, note: messageOf(error) };
      await cleanUp();
    }
    runs.push(run);
    console.log(`${scenario}#${String(i + 1)} ${run.ok ? 'ok  ' : 'FAIL'} ${run.note}`);
    // Each scenario reads the account a dozen times: spacing keeps the IP under HL's rate limit.
    await sleep(10_000);
  }
}

const passed = (s: string) => runs.filter((r) => r.scenario === s && r.ok).length;
const timed = runs.filter((r) => r.ok && r.slAheadOfFillMs !== undefined);
console.log(`\n${'scenario'.padEnd(16)}passed`);
for (const [scenario, count] of PLAN)
  console.log(`${scenario.padEnd(16)}${String(passed(scenario))}/${String(count)}`);
console.log(
  `median stop live ahead of first fill: ${String(median(timed.map((r) => r.slAheadOfFillMs ?? 0)))} ms`,
);
console.log(
  `median first fill to take-profit live: ${String(median(timed.map((r) => r.fillToTpMs ?? 0)))} ms`,
);
await writeFile('test-results/e2e-testnet.json', JSON.stringify(runs, null, 2));
process.exit(runs.every((run) => run.ok) ? 0 : 1);
