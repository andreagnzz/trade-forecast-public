import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { calibrate } from './e2e/calibrate';
import { COIN, flatten, median } from './e2e/harness';
import { scenarios, type Run } from './e2e/scenarios';

// a market bracket, b partial limit fill, c crossing take-profit, d close outside the app,
// e reload, f one-bullet refusal, g stop hit by the market.
const DEFAULT_RUNS: [string, number][] = [
  ['a', 10],
  ['c', 10],
  ['d', 10],
  ['e', 10],
  ['f', 10],
  ['b', 4],
  ['g', 4],
];

// `pnpm e2e:testnet a:1 c:2` runs a subset, `calibrate` re-measures closedPnl; no argument
// runs the full set.
const args = process.argv.slice(2);
if (args.includes('calibrate')) await calibrate();
const requested = args
  .filter((arg) => arg !== 'calibrate')
  .map((arg): [string, number] => {
    const [name = '', count = '1'] = arg.split(':');
    return [name, Number(count)];
  });
const PLAN = requested.length > 0 ? requested : DEFAULT_RUNS;
// A failed run must not take the rest down: a rate limit gets a minute to cool off, then one
// more try; if cleanup still fails, the next scenario's busy-coin check says so.
async function cleanUp() {
  for (const wait of [0, 60_000]) {
    await sleep(wait);
    try {
      await flatten(COIN);
      return;
    } catch (error) {
      console.log(`  cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const runs: Run[] = [];
for (const [scenario, count] of PLAN) {
  for (let i = 0; i < count; i++) {
    let run: Run;
    try {
      const play = scenarios[scenario];
      if (!play) throw new Error(`unknown scenario: ${scenario}`);
      run = { scenario, ok: true, ...(await play()) };
    } catch (error) {
      run = { scenario, ok: false, note: error instanceof Error ? error.message : String(error) };
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
console.log('\nscenario  passed');
for (const [scenario, count] of PLAN)
  console.log(`${scenario}         ${String(passed(scenario))}/${String(count)}`);
console.log(
  `median stop live ahead of first fill: ${String(median(timed.map((r) => r.slAheadOfFillMs ?? 0)))} ms`,
);
console.log(
  `median first fill to take-profit live: ${String(median(timed.map((r) => r.fillToTpMs ?? 0)))} ms`,
);
await writeFile('test-results/e2e-testnet.json', JSON.stringify(runs, null, 2));
process.exit(runs.every((run) => run.ok) ? 0 : 1);
