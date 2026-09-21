import { describe, expect, it } from 'bun:test';
import { base32Decode, base32Encode, base32Length } from './base32.js';

describe('base32', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      const decoded = base32Decode(base32Encode(bytes));
      expect(decoded).not.toBeNull();
      // Encoding pads the final character, so decoding can yield one trailing byte.
      expect(Array.from(decoded!.slice(0, length))).toEqual(Array.from(bytes));
    }
  });

  it('produces the documented length', () => {
    for (const length of [1, 5, 16, 32]) {
      expect(base32Encode(new Uint8Array(length)).length).toBe(base32Length(length));
    }
  });

  it('never emits the ambiguous characters', () => {
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    expect(base32Encode(bytes)).not.toMatch(/[ilou]/);
  });

  it('folds confusables and is case-insensitive when decoding', () => {
    const canonical = base32Encode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(base32Decode(canonical.toUpperCase())).toEqual(base32Decode(canonical));

    // `1` and `l`/`i` are the same digit; so are `0` and `o`.
    expect(base32Decode('1')).toEqual(base32Decode('l'));
    expect(base32Decode('1')).toEqual(base32Decode('I'));
    expect(base32Decode('0')).toEqual(base32Decode('O'));
  });

  it('returns null rather than throwing on junk', () => {
    expect(base32Decode('not-base32!')).toBeNull();
    expect(base32Decode('abc def')).toBeNull();
  });
});
