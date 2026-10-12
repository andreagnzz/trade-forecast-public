import { initialRulesState, type RulesState } from '../core/rules';

// Rules persist per master address in this browser only. Clearing site data resets them: a
// commitment aid in a standalone prototype, not an enforcement boundary.
const key = (master: string) => `tf.rules.${master}`;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const field = (value: object, name: string): unknown => Reflect.get(value, name);
// JSON has no NaN or Infinity, so a positive number is all a stored limit needs to be usable.
const isLimitUsd = (value: unknown) => typeof value === 'number' && value > 0;
const isLockReason = (value: unknown) => value === 'one_bullet' || value === 'loss_limit';

function isRules(value: unknown): boolean {
  if (!isObject(value) || typeof field(value, 'oneBullet') !== 'boolean') return false;
  const limit = field(value, 'lossLimit');
  return (
    limit === null ||
    (isObject(limit) &&
      isLimitUsd(field(limit, 'usd')) &&
      typeof field(limit, 'hard') === 'boolean')
  );
}

function isRulesState(value: unknown): value is RulesState {
  if (!isObject(value) || !isRules(field(value, 'rules'))) return false;
  const pending = field(value, 'pending');
  const lock = field(value, 'lock');
  return (
    (pending === null ||
      (isObject(pending) &&
        isRules(field(pending, 'rules')) &&
        typeof field(pending, 'from') === 'number')) &&
    (lock === null ||
      (isObject(lock) &&
        isLockReason(field(lock, 'reason')) &&
        typeof field(lock, 'until') === 'number'))
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
