import { describe, expect, it } from 'vitest';
import { connectAgent } from './exchange';

describe('connectAgent', () => {
  it.each([
    ['above the curve order', `0x${'f'.repeat(64)}`],
    ['zero', `0x${'0'.repeat(64)}`],
  ])('refuses a hex key %s as malformed without echoing it', async (_case, key) => {
    expect(await connectAgent(key)).toEqual({ ok: false, error: 'malformed_key' });
  });
});
