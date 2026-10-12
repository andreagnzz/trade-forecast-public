<script setup lang="ts">
import { ref } from 'vue';
import { useAccountStore } from '../stores/account';
import { useExecutionStore } from '../stores/execution';
import { signedUsd, usd } from './format';

const execution = useExecutionStore();
const account = useAccountStore();
const limitText = ref(String(account.rules.rules.lossLimit?.usd ?? ''));
const hard = ref(account.rules.rules.lossLimit?.hard ?? false);

const timeUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function toggleOneBullet(event: Event) {
  if (event.target instanceof HTMLInputElement) {
    execution.setRules({ oneBullet: event.target.checked });
  }
}

function applyLimit() {
  const text = limitText.value.trim();
  execution.setRules({ lossLimit: text === '' ? null : { usd: Number(text), hard: hard.value } });
}
</script>

<template>
  <details class="rules">
    <summary>
      Daily rules
      <span v-if="account.rules.lock" class="locked"
        >LOCKED until {{ timeUtc(account.rules.lock.until) }} UTC</span
      >
    </summary>
    <p class="num">
      Today {{ signedUsd(account.stats.dayPnlUsd) }}
      <template v-if="account.budgetLeftUsd !== undefined">
        · budget left {{ usd(account.budgetLeftUsd) }}
      </template>
    </p>
    <label class="check">
      <input type="checkbox" :checked="account.rules.rules.oneBullet" @change="toggleOneBullet" />
      One bullet: lock after the first losing round-trip of the day
    </label>
    <label class="field">
      <span class="muted">Daily loss limit ($, empty for none)</span>
      <span class="row">
        <input v-model="limitText" class="num" type="text" inputmode="decimal" />
        <label class="check"><input v-model="hard" type="checkbox" /> Hard</label>
        <button @click="applyLimit">Apply</button>
      </span>
    </label>
    <p v-if="account.rules.pending" class="muted">
      Looser rules apply from {{ timeUtc(account.rules.pending.from) }} UTC.
    </p>
    <p class="muted">
      A lock refuses exposure-increasing orders until 00:00 UTC. Cancels and reduce-only orders
      always go through. Stored in this browser only.
    </p>
  </details>
</template>

<style scoped>
.rules {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--rule);
}

summary {
  cursor: pointer;
}

p {
  margin: 4px 0;
}

.locked {
  margin-left: 6px;
  color: var(--short);
  font-weight: 600;
}

.check {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.row input[type='text'] {
  width: 90px;
  padding: 4px 6px;
  background: var(--bg);
  border: 1px solid var(--rule);
  text-align: right;
}

button {
  padding: 4px 8px;
  background: var(--raised);
  border: 1px solid var(--rule);
  cursor: pointer;
}
</style>
