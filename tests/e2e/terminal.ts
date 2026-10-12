import { expect, type Page } from '@playwright/test';

export const numberIn = (text: string | null) => Number((text ?? '').replace(/[^0-9.]/g, ''));

export async function openTerminal(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('size')).toBeVisible({ timeout: 15_000 });
  const box = await page.getByTestId('chart').boundingBox();
  if (!box) throw new Error('chart not rendered');
  return box;
}

// Scans up from the bottom of the chart until the drag cursor shows: on a long, the
// lowest line is the stop.
export async function findStopY(page: Page, x: number) {
  const chart = page.getByTestId('chart');
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart not rendered');
  for (let y = box.y + box.height - 30; y > box.y; y -= 2) {
    await page.mouse.move(x, y);
    if ((await chart.evaluate((el) => el.style.cursor)) === 'ns-resize') return y;
  }
  throw new Error('stop line not found');
}

interface VueRoot {
  __vue_app__?: { config: { globalProperties: { $pinia: { _s: Map<string, object> } } } };
}

// Vue sets __vue_app__ on the mount element in production builds too. Writing a store through
// it puts the terminal in a state the testnet takes minutes to reach, without any key.
export async function patchStore(page: Page, id: string, patch: Record<string, unknown>) {
  await page.evaluate(
    ({ id, patch }) => {
      const root = document.querySelector<HTMLElement & VueRoot>('#app');
      const store = root?.__vue_app__?.config.globalProperties.$pinia._s.get(id);
      if (!store) throw new Error(`store ${id} not found`);
      Object.assign(store, patch);
    },
    { id, patch },
  );
}

// Runs a store action, such as a second start racing the first.
export async function callStore(page: Page, id: string, action: string) {
  await page.evaluate(
    ({ id, action }) => {
      const root = document.querySelector<HTMLElement & VueRoot>('#app');
      const store = root?.__vue_app__?.config.globalProperties.$pinia._s.get(id);
      const run: unknown = store && Reflect.get(store, action);
      if (typeof run !== 'function') throw new Error(`action ${id}.${action} not found`);
      void Reflect.apply(run, store, []);
    },
    { id, action },
  );
}
