<script setup lang="ts">
import { useTemplateRef } from 'vue';
import { useExecutionStore } from '../stores/execution';

const execution = useExecutionStore();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const keyInput = useTemplateRef<HTMLInputElement>('keyInput');
const rememberInput = useTemplateRef<HTMLInputElement>('rememberInput');

// The key is read from the field once and the field is cleared: it never lives in reactive
// state, where Vue devtools could show it.
async function submit() {
  const input = keyInput.value;
  if (!input) return;
  const key = input.value;
  input.value = '';
  if (await execution.connect(key, rememberInput.value?.checked ?? false)) dialog.value?.close();
}

defineExpose({ open: () => dialog.value?.showModal() });
</script>

<template>
  <dialog ref="dialog" class="key-dialog" aria-label="Connect testnet">
    <form @submit.prevent="submit">
      <strong>Connect testnet</strong>
      <p class="muted">
        Paste the private key of a testnet agent (API wallet). Orders go to testnet only. A main
        wallet key is refused. Use a fresh API wallet made for this test, and never share a key.
      </p>
      <label class="field">
        <span class="muted">Agent key</span>
        <input
          ref="keyInput"
          class="num"
          type="password"
          autocomplete="off"
          spellcheck="false"
          required
        />
      </label>
      <label class="check">
        <input ref="rememberInput" type="checkbox" />
        Remember for this tab
      </label>
      <p v-if="execution.keyError" class="error" role="alert">{{ execution.keyError }}</p>
      <div class="actions">
        <button type="button" @click="dialog?.close()">Cancel</button>
        <button type="submit" class="primary" :disabled="execution.connecting">
          {{ execution.connecting ? 'Checking key' : 'Connect' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.key-dialog {
  width: 360px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--rule);
  color: var(--text);
}

.key-dialog::backdrop {
  background: rgb(0 0 0 / 60%);
}

form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

p {
  margin: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

input[type='password'] {
  padding: 5px 6px;
  background: var(--bg);
  border: 1px solid var(--rule);
}

.check {
  display: flex;
  gap: 6px;
  align-items: center;
}

.error {
  color: var(--short);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.actions button {
  padding: 5px 12px;
  background: var(--raised);
  border: 1px solid var(--rule);
  cursor: pointer;
}

.actions .primary {
  border-color: var(--long);
  color: var(--long);
}
</style>
