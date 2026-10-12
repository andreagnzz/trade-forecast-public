import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeCloid, parseCloid } from './cloid';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

describe('cloid', () => {
  it.each([
    { leg: 'entry', seq: 0, expected: `0x7466${ID}0100` },
    { leg: 'sl', seq: 1, expected: `0x7466${ID}0201` },
    { leg: 'tp', seq: 255, expected: `0x7466${ID}03ff` },
    { leg: 'close', seq: 2, expected: `0x7466${ID}0502` },
  ] as const)('encodes the app tag, bracket id, $leg leg and seq', ({ leg, seq, expected }) => {
    expect(makeCloid('7466', ID, leg, seq)).toBe(expected);
  });

  it('round-trips through parse', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('7466' as const, '7465' as const),
        fc.stringMatching(/^[0-9a-f]{24}$/),
        fc.constantFrom('entry' as const, 'sl' as const, 'tp' as const, 'close' as const),
        fc.integer({ min: 0, max: 255 }),
        (prefix, bracketId, leg, seq) => {
          expect(parseCloid(makeCloid(prefix, bracketId, leg, seq))).toEqual({
            prefix,
            bracketId,
            leg,
            seq,
          });
        },
      ),
    );
  });

  it.each([
    { name: 'a foreign tag', value: `0x1234${ID}0100` },
    { name: 'the unused leg 04', value: `0x7466${ID}0400` },
    { name: 'a short value', value: '0x7466' },
    { name: 'uppercase hex', value: `0x7466${ID.toUpperCase()}0100` },
  ])('rejects $name', ({ value }) => {
    expect(parseCloid(value)).toBeNull();
  });

  it('refuses a seq that does not fit one byte', () => {
    expect(() => makeCloid('7466', ID, 'tp', 256)).toThrow();
  });
});
