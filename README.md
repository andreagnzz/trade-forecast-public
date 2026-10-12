# Trade Forecast

Browser-only prototype for Hyperliquid perps: drag your stop on the chart, see the dollar risk live, and the risk-based size follows the drag.
One key sends a bracket (entry, reduce-only stop-loss trigger, reduce-only post-only take-profit) built to survive partial fills, rejections and reloads.
Orders go to the Hyperliquid testnet only; mainnet is used read-only for prices.

![Dragging the stop and the take-profit in Preview mode](docs/demo.gif)

## Try it

**Preview, no wallet.** Open https://trade-forecast-pi.vercel.app. Prices are live mainnet, read-only; the equity is hypothetical. Drag the red stop line and watch the size, the dollar risk and the R:R follow. Press `?` for the keyboard shortcuts.

**Testnet, optional.** Sending a bracket needs a Hyperliquid testnet account and an agent (API wallet) key:

1. Fund a testnet account. The testnet faucet (https://app.hyperliquid-testnet.xyz/drip) only pays out to an address that has already deposited on mainnet.
2. In the testnet app, create a fresh API wallet for this test and copy its private key.
3. In Trade Forecast, click "Connect testnet to execute" and paste the agent key.

The app only accepts an agent key: a main wallet key is refused, because its `userRole` is not `agent`. An agent can place and cancel orders but cannot withdraw. The key stays in memory for the tab and is never stored, unless you tick "Remember for this tab" (session storage, cleared when the tab closes). Never paste a main wallet key, and never send a key to anyone, including the author of this project: nobody needs it to help you.

## Architecture

```
   src/ui, src/stores (Vue, Pinia)
     │  sizing and rules from core, market and account reads from hl
     │  every order through services
     ▼
   src/services   OrderService: preTradeCheck → sign → send, the only way an order leaves
                  BracketManager: runs the reducer's commands, feeds back events
     │
     ├──► src/core   pure, no I/O
     └──► src/hl     SDK wrapper: testnet execution transport (hard-coded),
                     mainnet read-only market data, error mapping
```

`src/core` is exchange-agnostic: sizing, daily budget, round-trips, rules, the pre-trade check and the bracket state machine. It has no I/O, no clock and no randomness; the bracket is a pure reducer `(state, event) => { state, commands }`, and `BracketManager` only executes the commands. `@nktkas/hyperliquid` is imported only in `src/hl`.

Execution order on Send: a reduce-only position stop (`positionTpsl`, size 0, triggers on the mark price) is placed first; the entry goes out only if the stop was accepted. Every fill, partial or full, is therefore covered on the exchange side as it happens. The take-profit is a reduce-only post-only limit placed at the filled size and resized as fills arrive.

## Invariants and tests

- **Never naked.** The stop is placed before the entry; if the book loses it while a position is open, it is placed again. If that keeps failing, the bracket is flagged unprotected and offers a reduce-only close at market; no order is sent automatically.
- **Take-profit at the filled size.** A take-profit that would cross is never replaced silently: the trader picks take profit at market, rest at the best maker price, or keep the stop only.
- **Clean exit.** When the position goes flat (stop, take-profit or a close outside the app), no leg stays open.
- **Idempotent.** Every order is keyed by its client order id. An entry whose answer is lost is checked with `orderStatus`, never resent.
- **Rebuilt after a reload** from local state, the open orders and the fills, without duplicate orders.
- **One position per coin.** Send is refused while the coin holds a position or open orders.

Evidence:

- Unit and property tests (`pnpm test`); line coverage of `src/core` is above 99% (`pnpm test:coverage`). A fast-check property drives the bracket reducer through random fills, rejects, lost answers, lost stops and reloads, and checks that the stop is never cancelled with a position open, that no client order id is sent twice, that the entry is placed at most once, and that a closed bracket leaves a flat position and an empty book.
- Sizing properties: the loss at the stop, fees and slippage buffer included, never exceeds the requested risk; sizes are whole lots and round down; every sized leg is at or above the $10 minimum.
- Testnet end-to-end run on a separate account (`pnpm e2e:testnet`): full market bracket, crossing take-profit, outside close, reload and one-bullet refusal 10/10 each; partial limit fill 3/4; stop hit by the market 4 documented runs. The stop is live about 1.3 s (median) before the first fill.
- Playwright (`pnpm test:e2e`): dragging the stop resizes the position without exceeding the requested risk, typing in the risk field never moves a line, a drag stays under 20 ms per frame at the 95th percentile, and each terminal state is captured at desktop and phone width.

## Limits

- Testnet only. Nothing here has run against mainnet orders.
- The stop is a trigger market order: the fill can slip past the stop price. Sizing keeps a slippage buffer, but a fast market can exceed it.
- The take-profit is placed or resized only while a tab is open. The stop is on the exchange regardless, so a limit entry filled with the tab closed is protected but has no take-profit, or one that is too small, until the tab comes back.
- The daily rules and the running bracket are stored in this browser only. Another device or client is not bound by them.

## Run locally

```sh
pnpm install
pnpm dev
pnpm typecheck && pnpm lint && pnpm test
```

Requires Node 22.12+ and pnpm 10.

`pnpm e2e:testnet` runs the testnet scenarios. It reads `HL_E2E_AGENT_KEY` from `.env.local`: the agent key of a separate testnet account used only for these runs, so its losing round-trips never touch the account you trade with.

`pnpm demo:record [url]` records a 20-second demo video to `demo/demo.webm` against a running dev or preview server.

## Status

- Preview mode: live mainnet BTC candles, best bid/ask and mark price (read-only), a hypothetical equity, and draggable entry, stop and take-profit lines. The size, dollar risk, fees, gain and R:R update on every drag; the stop label shows the dollar risk and the distance from entry and mark, the take-profit label the net gain and the R multiple. Keyboard: `1` `2` `3` place a line at the cursor, `X` long/short, `M` market/limit, `R` focus risk, `Enter` send, `Esc` reset, `?` help.
- Testnet execution: agent key connection, the bracket described above, optional daily rules (one bullet, hard loss limit) that refuse exposure-increasing orders until 00:00 UTC while cancels and reduce-only orders always go through.
- Terminal states: loading, market data error with retry, market or account feed disconnected, take-profit attention, unprotected position, daily lock. A first-run hint and the `?` shortcut list explain the controls.
- Public preview: https://trade-forecast-pi.vercel.app.
