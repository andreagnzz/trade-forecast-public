import type { Bracket } from '../core/bracket/bracket';

export interface Saved {
  version: 3;
  since: number;
  bracket: Bracket;
}

function isSaved(value: unknown): value is Saved {
  if (typeof value !== 'object' || value === null) return false;
  const bracket: unknown = Reflect.get(value, 'bracket');
  return (
    Reflect.get(value, 'version') === 3 &&
    typeof Reflect.get(value, 'since') === 'number' &&
    typeof bracket === 'object' &&
    bracket !== null
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
