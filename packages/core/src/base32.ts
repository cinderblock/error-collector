/**
 * Crockford base32, lowercase, unpadded.
 *
 * Chosen over hex (shorter) and over standard RFC 4648 base32 (which includes the
 * `i`/`l`/`o`/`u` characters — ambiguous when read aloud or retyped, and `u` is the
 * one that lets a random token spell something unfortunate). Decoding is
 * case-insensitive and folds the classic confusables, so a key transcribed by hand
 * with `1` for `l` or `0` for `O` still resolves.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

const DECODE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE[ALPHABET[i]!] = i;
  DECODE[ALPHABET[i]!.toUpperCase()] = i;
}
// Confusable folding, per the Crockford spec.
for (const [from, to] of [
  ['i', '1'],
  ['I', '1'],
  ['l', '1'],
  ['L', '1'],
  ['o', '0'],
  ['O', '0'],
] as const) {
  DECODE[from] = DECODE[to]!;
}

/** Number of base32 characters needed to hold `byteLength` bytes. */
export function base32Length(byteLength: number): number {
  return Math.ceil((byteLength * 8) / 5);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Left-align the remainder into the final character rather than dropping it.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/** Returns `null` on any character outside the alphabet, rather than throwing. */
export function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of text) {
    const digit = DECODE[char];
    if (digit === undefined) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}
