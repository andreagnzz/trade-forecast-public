<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Sizing } from '../core/sizing';
import { useAccountStore } from '../stores/account';
import { useExecutionStore } from '../stores/execution';
import { MIN_NOTIONAL_USD, STOP_SLIPPAGE_BUFFER, useTerminalStore } from '../stores/terminal';
import BracketTimeline from './BracketTimeline.vue';
import RulesDrawer from './RulesDrawer.vue';
import { loss, pct, price, rMultiple, signedUsd, sizingErrorText, usd, wholeUsd } from './format';

const store = useTerminalStore();
const execution = useExecutionStore();
const account = useAccountStore();
const emit = defineEmits<{ connect: [] }>();

const sendLabel = computed(() =>
  account.master ? (execution.blocker ?? 'Send bracket') : 'Connect testnet to execute',
);

function onSend() {
  if (!account.master) emit('connect');
  else void execution.send();
}

const MIN_NOTIONAL_TEXT = `${wholeUsd(MIN_NOTIONAL_USD)} minimum`;
const STOP_BUFFER_TEXT = `${String(STOP_SLIPPAGE_BUFFER * 100)}%`;

const BINDING_TEXT: Record<Sizing['binding'], string> = {
  risk: 'risk',
  budget: 'daily budget',
  max_trade_sz: 'max trade size',
  leverage: 'max leverage',
  min_notional: MIN_NOTIONAL_TEXT,
};

const error = computed(() => {
  const sizingResult = store.sizing;
  return sizingResult && !sizingResult.ok
    ? sizingErrorText(sizingResult.error, store.side)
    : undefined;
});

const parse = (text: string) => (text.trim() === '' ? NaN : Number(text));

// The field keeps what was typed ("", "0.") while the store holds the parsed number;
// binding the input to the number would rewrite the text on every keystroke.
function numberField(read: () => number, write: (value: number) => void) {
  const text = ref(String(read()));
  watch(text, (next) => {
    write(parse(next));
  });
  watch(read, (value) => {
    if (!Object.is(parse(text.value), value)) text.value = String(value);
  });
  return text;
}

const riskText = numberField(
  () => store.risk.value,
  (value) => (store.risk = { kind: store.risk.kind, value }),
);
const equityText = numberField(
  () => store.equity,
  (value) => (store.equity = value),
);
</script>

<template>
  <section class="panel" data-testid="forecast" aria-label="Forecast">
    <BracketTimeline />
    <div class="toggles">
      <div class="segmented" role="group" aria-label="Side">
        <button
          :aria-pressed="store.side === 'long'"
          class="long-btn"
          @click="store.setSide('long')"
        >
          Long
        </button>
        <button
          :aria-pressed="store.side === 'short'"
          class="short-btn"
          @click="store.setSide('short')"
        >
          Short
        </button>
      </div>
      <div class="segmented" role="group" aria-label="Entry type">
        <button :aria-pressed="store.entryKind === 'market'" @click="store.setEntryKind('market')">
          Market
        </button>
        <button :aria-pressed="store.entryKind === 'limit'" @click="store.setEntryKind('limit')">
          Limit
        </button>
      </div>
    </div>

    <div class="inputs">
      <label class="field">
        <span class="muted">Risk</span>
        <span class="input-row">
          <input id="risk-input" v-model="riskText" class="num" type="text" inputmode="decimal" />
          <span class="segmented unit" role="group" aria-label="Risk unit">
            <button
              :aria-pressed="store.risk.kind === 'pct_equity'"
              @click="store.setRiskKind('pct_equity')"
            >
              %
            </button>
            <button :aria-pressed="store.risk.kind === 'usd'" @click="store.setRiskKind('usd')">
              $
            </button>
          </span>
        </span>
      </label>
      <label class="field">
        <template v-if="store.account">
          <span class="muted">Equity <span class="hint">testnet account</span></span>
          <span class="num equity">{{ wholeUsd(store.account.equity) }}</span>
        </template>
        <template v-else>
          <span class="muted">Equity <span class="hint">hypothetical</span></span>
          <input v-model="equityText" class="num" type="text" inputmode="decimal" />
        </template>
      </label>
    </div>

    <div class="hero" data-testid="risk-at-stop">
      <span class="muted">Loss at stop</span>
      <strong class="num short">{{ store.okSizing ? loss(store.okSizing.riskUsd) : '—' }}</strong>
      <span v-if="store.okSizing" class="num muted breakdown">
        <span>{{ pct(store.okSizing.riskPct) }} of equity</span> ·
        <span>price {{ usd(store.okSizing.priceRiskUsd) }}</span> ·
        <span>fees {{ usd(store.okSizing.feesAtStopUsd) }}</span>
      </span>
    </div>

    <p v-if="error" class="notice error" role="alert">{{ error }}</p>

    <dl v-if="store.okSizing" class="figures num">
      <dt>Size</dt>
      <dd data-testid="size">{{ store.okSizing.size }} {{ store.coin }}</dd>
      <dt>Notional</dt>
      <dd>{{ wholeUsd(store.okSizing.notional) }}</dd>
      <dt>Leverage</dt>
      <dd>{{ store.okSizing.leverage.toFixed(2) }}x</dd>
      <dt>Entry</dt>
      <dd>
        {{ price(store.okSizing.expectedEntryPx) }}
        <span v-if="store.entryKind === 'market'" class="muted">
          IOC {{ price(store.okSizing.entryPx) }}
        </span>
        <span v-else-if="store.limitCrosses" class="crosses">crosses · taker</span>
        <span v-else class="muted">rests · maker</span>
      </dd>
      <dt>Stop</dt>
      <dd class="short" data-testid="stop">{{ price(store.okSizing.stopPx) }}</dd>
      <template v-if="store.okSizing.tpPx !== undefined && store.okSizing.rewardUsd !== undefined">
        <dt>Take-profit</dt>
        <dd class="long">{{ price(store.okSizing.tpPx) }}</dd>
        <dt>Gain at TP</dt>
        <dd :class="store.okSizing.rewardUsd < 0 ? 'short' : 'long'">
          {{ signedUsd(store.okSizing.rewardUsd) }}
        </dd>
      </template>
      <template v-if="store.okSizing.rr !== undefined">
        <dt>R:R</dt>
        <dd>{{ rMultiple(store.okSizing.rr) }}</dd>
      </template>
      <dt>At best price</dt>
      <dd class="muted">{{ loss(store.okSizing.expectedRiskUsd) }}</dd>
      <dt>Limited by</dt>
      <dd data-testid="binding">{{ BINDING_TEXT[store.okSizing.binding] }}</dd>
    </dl>

    <p v-if="store.okSizing?.status === 'below_min'" class="notice warn">
      Below the {{ MIN_NOTIONAL_TEXT }} per order.
      <template v-if="store.okSizing.minProposal">
        Minimum {{ store.okSizing.minProposal.size }} {{ store.coin }} risks
        {{ usd(store.okSizing.minProposal.riskUsd) }}.
      </template>
    </p>
    <p v-if="store.okSizing?.warnings.includes('tp_inside_expected_entry')" class="notice warn">
      Take-profit inside the worst-case fill after fees.
    </p>

    <button
      class="send"
      :class="{ ready: execution.canSend }"
      :disabled="!!account.master && !execution.canSend"
      data-testid="send"
      @click="onSend"
    >
      {{ sendLabel }}
    </button>
    <p v-if="execution.notice" class="muted status">{{ execution.notice }}</p>
    <p v-if="account.syncError" class="muted status">{{ account.syncError }}</p>
    <RulesDrawer v-if="account.master" />
    <p class="disclaimer muted">
      Stops trigger on the mark price. Slippage at the stop can exceed the
      {{ STOP_BUFFER_TEXT }} buffer.
    </p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--surface);
  border-left: 1px solid var(--rule);
  overflow-y: auto;
}

.toggles,
.inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.segmented {
  display: flex;
  border: 1px solid var(--rule);
}

.segmented button {
  flex: 1;
  padding: 5px 8px;
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
}

.segmented button + button {
  border-left: 1px solid var(--rule);
}

.segmented button[aria-pressed='true'] {
  background: var(--raised);
  color: var(--text);
}

.segmented .long-btn[aria-pressed='true'] {
  color: var(--long);
  box-shadow: inset 0 -2px 0 var(--long);
}

.segmented .short-btn[aria-pressed='true'] {
  color: var(--short);
  box-shadow: inset 0 -2px 0 var(--short);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hint {
  font-size: 10px;
}

.input-row {
  display: flex;
}

.input-row input {
  min-width: 0;
  flex: 1;
}

.unit button {
  flex: none;
  width: 26px;
  padding: 5px 0;
}

input {
  width: 100%;
  padding: 5px 6px;
  background: var(--bg);
  border: 1px solid var(--rule);
  text-align: right;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.hero strong {
  font-size: 34px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.figures {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
}

.figures dt {
  color: var(--muted);
  font-family: var(--font-sans);
}

.figures dd {
  margin: 0;
  text-align: right;
}

.notice {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid;
  background: var(--raised);
}

.notice.warn {
  border-color: var(--warn);
}

.notice.error {
  border-color: var(--short);
}

.send {
  margin-top: auto;
  padding: 10px;
  background: var(--raised);
  border: 1px solid var(--rule);
  color: var(--muted);
  cursor: pointer;
}

.send.ready {
  border-color: var(--long);
  color: var(--long);
  font-weight: 600;
}

.send:disabled {
  cursor: default;
}

.breakdown span {
  white-space: nowrap;
}

.equity {
  padding: 5px 0;
  text-align: right;
}

.crosses {
  color: var(--warn);
}

.status {
  margin: 0;
}

.disclaimer {
  margin: 0;
  font-size: 11px;
}

@media (max-width: 760px) {
  .panel {
    overflow-y: visible;
  }
}
</style>
