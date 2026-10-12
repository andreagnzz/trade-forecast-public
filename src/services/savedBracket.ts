import { LEGS, type Bracket } from '../core/bracket/bracket';

export interface Saved {
  version: 4;
  since: number;
  bracket: Bracket;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

function isBracket(value: unknown): value is Bracket {
  if (!isObject(value)) return false;
  const plan: unknown = Reflect.get(value, 'plan');
  return (
    isObject(plan) &&
    typeof Reflect.get(plan, 'id') === 'string' &&
    typeof Reflect.get(plan, 'coin') === 'string' &&
    LEGS.every((leg) => isObject(Reflect.get(value, leg)))
  );
}

function isSaved(value: unknown): value is Saved {
  return (
    isObject(value) &&
    Reflect.get(value, 'version') === 4 &&
    typeof Reflect.get(value, 'since') === 'number' &&
    isBracket(Reflect.get(value, 'bracket'))
  );
}

// Storage is outside our control: anything unreadable is dropped, never thrown.
export function readSaved(raw: string | null): Saved | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSaved(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
