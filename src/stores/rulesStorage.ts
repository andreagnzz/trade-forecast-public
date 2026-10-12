import { initialRulesState, type RulesState } from '../core/rules';

// Rules persist per master address in this browser only. Clearing site data resets them: a
// commitment aid in a standalone prototype, not an enforcement boundary.
const key = (master: string) => `tf.rules.${master}`;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
// JSON has no NaN or Infinity, so a positive number is all a stored limit needs to be usable.
const isLimitUsd = (value: unknown) => typeof value === 'number' && value > 0;
const isLockReason = (value: unknown) => value === 'one_bullet' || value === 'loss_limit';

function isRules(value: unknown): boolean {
  if (!isObject(value) || typeof Reflect.get(value, 'oneBullet') !== 'boolean') return false;
  const limit: unknown = Reflect.get(value, 'lossLimit');
  return (
    limit === null ||
    (isObject(limit) &&
      isLimitUsd(Reflect.get(limit, 'usd')) &&
      typeof Reflect.get(limit, 'hard') === 'boolean')
  );
}

function isRulesState(value: unknown): value is RulesState {
  if (!isObject(value) || !isRules(Reflect.get(value, 'rules'))) return false;
  const pending: unknown = Reflect.get(value, 'pending');
  const lock: unknown = Reflect.get(value, 'lock');
  return (
    (pending === null ||
      (isObject(pending) &&
        isRules(Reflect.get(pending, 'rules')) &&
        typeof Reflect.get(pending, 'from') === 'number')) &&
    (lock === null ||
      (isObject(lock) &&
        isLockReason(Reflect.get(lock, 'reason')) &&
        typeof Reflect.get(lock, 'until') === 'number'))
  );
}

export function loadRules(master: string): RulesState {
  try {
    const raw = localStorage.getItem(key(master));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isRulesState(parsed) ? parsed : initialRulesState;
  } catch {
    return initialRulesState;
  }
}

export function saveRules(master: string, state: RulesState) {
  localStorage.setItem(key(master), JSON.stringify(state));
}
