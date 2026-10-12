<script setup lang="ts">
import { computed } from 'vue';
import {
  isTpAttention,
  openSize,
  rMultiple as bracketR,
  type Attention,
  type Phase,
} from '../core/bracket/bracket';
import { useAccountStore } from '../stores/account';
import { useExecutionStore } from '../stores/execution';
import { MIN_NOTIONAL_USD, useTerminalStore } from '../stores/terminal';
import { rMultiple, signedUsd, wholeUsd } from './format';

const execution = useExecutionStore();
const account = useAccountStore();
const terminal = useTerminalStore();

const PHASES: Record<Phase, string> = {
  submitting: 'Placing stop',
  entry_working: 'Entry working',
  partial: 'Partially protected',
  protected: 'Protected',
  closing: 'Closing',
  closed: 'Closed',
  cancelled: 'Cancelled',
  attention: 'Attention',
};

const ATTENTION: Record<Attention, string> = {
  entry_unknown: 'Entry status unknown: the exchange has no record of it. The stop stays.',
  sl_failed: 'Stop could not be placed.',
  tp_would_cross: 'Take-profit rejected: post-only would cross. Price is already past the target.',
  tp_below_min: `Take-profit rejected: below the ${wholeUsd(MIN_NOTIONAL_USD)} minimum.`,
  tp_failed: 'Take-profit could not be placed.',
  close_failed: 'Market close did not fill.',
};

const LEG_MARK = {
  idle: '·',
  sending: '…',
  live: '✓',
  canceling: '…',
  waiting: '↻',
  filling: '…',
  done: '–',
};

const legs = computed(() => {
  const b = execution.bracket;
  if (!b) return '';
  const tp =
    b.tp.px === null
      ? 'TP off'
      : b.tp.status === 'live'
        ? `TP ${LEG_MARK.live} resting (post-only)`
        : `TP ${LEG_MARK[b.tp.status]}`;
  return [
    // A finished entry that filled reads as done-and-good, not as a dash.
    `Entry ${b.entry.status === 'done' && b.filledSz > 0 ? '✓' : LEG_MARK[b.entry.status]} ${String(b.filledSz)}/${String(b.plan.size)}`,
    `SL ${LEG_MARK[b.sl.status]}`,
    tp,
  ].join(' · ');
});

const tpChoices = computed(() => isTpAttention(execution.bracket?.attention ?? null));
</script>

<template>
  <section class="timeline" aria-label="Bracket">
    <template v-if="execution.bracket && execution.bracketPhase">
      <header>
        <strong
          :class="{
            long: execution.bracketPhase === 'protected',
            attention: execution.bracketPhase === 'attention',
          }"
        >
          {{ PHASES[execution.bracketPhase] }}
        </strong>
        <span class="num muted">{{ legs }}</span>
      </header>

      <p
        v-if="execution.unprotected && !execution.bracket.outcome"
        class="banner danger"
        role="alert"
      >
        UNPROTECTED: {{ openSize(execution.bracket) }} {{ execution.bracket.plan.coin }} without a
        live stop.
        <button @click="execution.closeAtMarket()">Close at market (reduce-only)</button>
      </p>

      <div
        v-if="execution.bracket.attention && !execution.bracket.outcome"
        class="banner warn"
        role="alert"
      >
        <span>{{ ATTENTION[execution.bracket.attention] }}</span>
        <span class="choices">
          <template v-if="tpChoices && !execution.unprotected">
            <button @click="execution.closeAtMarket()">Take profit at market</button>
            <button
              v-if="execution.bracket.attention !== 'tp_below_min'"
              @click="execution.restAtBestMaker()"
            >
              Rest at best maker price
            </button>
            <button @click="execution.keepStopOnly()">Keep stop only</button>
          </template>
          <button
            v-else-if="execution.bracket.attention === 'entry_unknown'"
            @click="execution.dismiss()"
          >
            Dismiss and remove the stop
          </button>
          <button v-else-if="!execution.unprotected" @click="execution.closeAtMarket()">
            Close at market (reduce-only)
          </button>
        </span>
      </div>

      <p v-if="execution.bracket.outcome?.kind === 'closed'" class="num">
        Result {{ signedUsd(execution.bracket.pnlUsd) }} ·
        {{ rMultiple(bracketR(execution.bracket)) }}
      </p>
      <p v-if="execution.view.lastError" class="muted">{{ execution.view.lastError }}</p>

      <div
        v-if="execution.bracketPhase === 'entry_working' || execution.bracketPhase === 'partial'"
      >
        <button v-if="execution.bracket.entry.status === 'live'" @click="execution.cancelEntry()">
          Cancel rest of entry
        </button>
      </div>
    </template>

    <div v-if="execution.stray" class="banner warn">
      <span>
        Exposure on {{ terminal.coin }} without a local bracket. The position stop, if any, still
        protects it on the exchange.
      </span>
      <span class="choices">
        <button
          v-if="(account.position?.size ?? 0) > 0"
          :disabled="execution.strayBusy"
          @click="execution.closeStray()"
        >
          Close at market (reduce-only)
        </button>
        <button
          v-for="order in execution.strayOrders"
          :key="order.cloid"
          :disabled="execution.strayBusy"
          @click="execution.cancelStray(order.cloid)"
        >
          Cancel {{ order.reduceOnly ? 'reduce-only order' : 'order' }} {{ order.size }}
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  position: sticky;
  top: -12px;
  z-index: 1;
  max-height: 50vh;
  overflow-y: auto;
  /* A scrolling flex item may shrink to nothing when the panel overflows. */
  flex-shrink: 0;
  margin: -12px -12px 0;
  padding: 12px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.timeline:empty {
  display: none;
}

header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

p {
  margin: 0;
}

.attention {
  color: var(--warn);
}

.banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid;
  background: var(--raised);
}

.banner.warn {
  border-color: var(--warn);
}

.banner.danger {
  border-color: var(--short);
  color: var(--short);
  font-weight: 600;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

button {
  padding: 4px 8px;
  background: var(--bg);
  border: 1px solid var(--rule);
  cursor: pointer;
}
</style>
