<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { useAccountStore } from './stores/account';
import { useExecutionStore } from './stores/execution';
import { useTerminalStore, type Leg } from './stores/terminal';
import KeyDialog from './ui/KeyDialog.vue';
import ForecastPanel from './ui/ForecastPanel.vue';
import PriceChart from './ui/PriceChart.vue';
import { price } from './ui/format';

const SHORTCUTS = [
  ['1', 'Entry at cursor'],
  ['2', 'Stop at cursor'],
  ['3', 'Take-profit at cursor'],
  ['X', 'Long / short'],
  ['M', 'Market / limit'],
  ['R', 'Focus risk'],
  ['Enter', 'Send bracket'],
  ['Esc', 'Reset lines'],
  ['?', 'This help'],
] as const;

const LEG_KEYS: Partial<Record<string, Leg>> = { '1': 'entry', '2': 'stop', '3': 'tp' };

const HINT_STORAGE = 'tf.hintSeen';

const store = useTerminalStore();
const execution = useExecutionStore();
const account = useAccountStore();
const help = useTemplateRef<HTMLDialogElement>('help');
const keyDialog = useTemplateRef<InstanceType<typeof KeyDialog>>('keyDialog');

// Storage throws when site data is blocked.
function readHintSeen() {
  try {
    return localStorage.getItem(HINT_STORAGE) === '1';
  } catch {
    return false;
  }
}

const showHint = ref(!readHintSeen());
const hintVisible = computed(() => showHint.value && store.status === 'ready');

function dismissHint() {
  if (!hintVisible.value) return;
  showHint.value = false;
  try {
    localStorage.setItem(HINT_STORAGE, '1');
  } catch {
    // Not remembered: the hint shows again on the next visit.
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function onKeydown(event: KeyboardEvent) {
  if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (help.value?.open && event.key !== '?') return;
  const leg = LEG_KEYS[event.key];
  if (leg) {
    const px = store.cursorPx;
    if (px !== undefined) store.moveLine(leg, px);
    return;
  }
  switch (event.key.toLowerCase()) {
    case 'x':
      store.setSide(store.side === 'long' ? 'short' : 'long');
      break;
    case 'm':
      store.setEntryKind(store.entryKind === 'market' ? 'limit' : 'market');
      break;
    case 'r':
      event.preventDefault();
      document.getElementById('risk-input')?.focus();
      break;
    case 'escape':
      store.reset();
      break;
    case 'enter':
      // A click on the chart or panel leaves focus on the body: neither is focusable. A focused
      // link, button or summary keeps its own Enter action and never sends.
      if (event.target !== document.body) break;
      if (account.master) void execution.send();
      else keyDialog.value?.open();
      break;
    case '?':
      if (help.value?.open) help.value.close();
      else help.value?.showModal();
      break;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void store.start();
  execution.resume();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="terminal">
    <header class="bar">
      <span class="name">Trade Forecast</span>
      <span class="instrument num">{{ store.coin }}-PERP</span>
      <span v-if="store.markPx > 0" class="num">
        <span class="muted">Mark</span> {{ price(store.markPx) }}
      </span>
      <span
        v-if="store.network === 'testnet'"
        class="badge live"
        :title="`Testnet orders signed by an agent of ${account.master ?? ''}`"
      >
        Testnet live
      </span>
      <span v-else class="badge" title="Live mainnet prices, read-only. Orders are disabled.">
        Mainnet preview
      </span>
    </header>

    <p v-if="store.connection === 'closed'" class="banner" role="status">
      Market data disconnected. Reconnecting.
    </p>
    <p v-if="execution.accountFeed === 'closed'" class="banner" role="status">
      Account feed disconnected. Reconnecting.
    </p>

    <main class="body">
      <div class="chart-area" @pointerdown="dismissHint">
        <PriceChart />
        <p v-if="hintVisible" class="hint">
          Drag the red stop line: the size follows your risk. Press ? for shortcuts.
          <button class="link" @click="dismissHint">Dismiss</button>
        </p>
        <p v-if="store.status === 'loading'" class="overlay muted">Loading {{ store.coin }}</p>
        <p v-if="store.status === 'error'" class="overlay" role="alert">
          <span>Market data unavailable. <button @click="store.start()">Retry</button></span>
        </p>
      </div>
      <ForecastPanel @connect="keyDialog?.open()" />
    </main>

    <footer class="bar foot muted">
      <span>Drag entry, stop or take-profit on the chart.</span>
      <button class="link" @click="help?.showModal()">Shortcuts ?</button>
      <span class="spacer" />
      <a href="https://www.tradingview.com/" target="_blank" rel="noopener"
        >Charts by TradingView</a
      >
    </footer>

    <KeyDialog ref="keyDialog" />

    <dialog ref="help" class="help" closedby="any">
      <dl>
        <template v-for="[key, action] in SHORTCUTS" :key="key">
          <dt class="num">{{ key }}</dt>
          <dd>{{ action }}</dd>
        </template>
      </dl>
      <p class="muted">Shortcuts are off while typing in a field.</p>
      <button @click="help?.close()">Close</button>
    </dialog>
  </div>
</template>

<style scoped>
.terminal {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}

.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  height: 36px;
  border-bottom: 1px solid var(--rule);
  background: var(--surface);
  white-space: nowrap;
}

.name {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.instrument {
  color: var(--text);
}

.badge {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--entry);
  color: var(--entry);
  font-size: 11px;
}

.badge.live {
  border-color: var(--long);
  color: var(--long);
}

.banner {
  margin: 0;
  padding: 4px 12px;
  background: var(--raised);
  border-bottom: 1px solid var(--warn);
  color: var(--warn);
}

.body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  min-height: 0;
}

.chart-area {
  position: relative;
  min-height: 0;
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  margin: 0;
  background: var(--bg);
}

.overlay button,
.help button {
  padding: 4px 8px;
  background: var(--raised);
  border: 1px solid var(--rule);
  cursor: pointer;
}

.hint {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 80px);
  z-index: 2;
  margin: 0;
  padding: 6px 10px;
  background: var(--raised);
  border: 1px solid var(--rule);
  pointer-events: none;
}

.hint .link {
  margin-left: 8px;
  pointer-events: auto;
}

.foot {
  border-top: 1px solid var(--rule);
  border-bottom: 0;
  height: 28px;
  font-size: 11px;
}

.spacer {
  flex: 1;
}

.foot a,
.link {
  color: var(--muted);
  text-decoration: none;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}

.foot a:hover,
.link:hover {
  color: var(--text);
}

.help {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--rule);
  padding: 16px 20px;
}

.help::backdrop {
  background: rgb(0 0 0 / 0.6);
}

.help dl {
  display: grid;
  grid-template-columns: 40px auto;
  gap: 6px 12px;
  margin: 0 0 12px;
}

.help dd {
  margin: 0;
}

.help p {
  margin: 0 0 12px;
  font-size: 11px;
}

@media (max-width: 760px) {
  .bar {
    gap: 10px;
  }

  .terminal {
    height: auto;
  }

  .body {
    grid-template-columns: minmax(0, 1fr);
  }

  .chart-area {
    height: 60vh;
  }

  .foot {
    flex-wrap: wrap;
    height: auto;
    padding: 6px 12px;
  }
}
</style>
