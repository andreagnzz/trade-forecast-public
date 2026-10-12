export type CloidPrefix = '7466' | '7465';
export const APP_PREFIX = '7466' satisfies CloidPrefix;
export const E2E_PREFIX = '7465' satisfies CloidPrefix;
export type LegName = 'entry' | 'sl' | 'tp' | 'close';
export type Cloid = `0x${string}`;

const LEG_BYTES: Record<LegName, string> = { entry: '01', sl: '02', tp: '03', close: '05' };
const LEGS_BY_BYTE: Partial<Record<string, LegName>> = {
  '01': 'entry',
  '02': 'sl',
  '03': 'tp',
  '05': 'close',
};
const PATTERN = /^0x(7466|7465)([0-9a-f]{24})([0-9a-f]{2})([0-9a-f]{2})$/;

export function makeCloid(
  prefix: CloidPrefix,
  bracketId: string,
  leg: LegName,
  seq: number,
): Cloid {
  if (!/^[0-9a-f]{24}$/.test(bracketId)) throw new Error(`bad bracket id: ${bracketId}`);
  if (!(Number.isInteger(seq) && seq >= 0 && seq <= 255))
    throw new Error(`bad seq: ${String(seq)}`);
  return `0x${prefix}${bracketId}${LEG_BYTES[leg]}${seq.toString(16).padStart(2, '0')}`;
}

export const isCloid = (value: string): value is Cloid => PATTERN.test(value);

export function parseCloid(
  value: string,
): { prefix: CloidPrefix; bracketId: string; leg: LegName; seq: number } | null {
  const [, prefix, bracketId = '', legByte = '', seqByte = ''] = PATTERN.exec(value) ?? [];
  const leg = LEGS_BY_BYTE[legByte];
  if ((prefix !== '7466' && prefix !== '7465') || !leg) return null;
  return { prefix, bracketId, leg, seq: Number.parseInt(seqByte, 16) };
}
