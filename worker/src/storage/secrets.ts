/**
 * Envelope encryption for app secrets at rest.
 *
 * The worker must hold each app's secret in usable form — verifying an ingest key
 * means recomputing an HMAC with it — so it cannot be stored as a one-way digest.
 * Sealing it under a worker-held key instead means a D1 dump on its own yields
 * nothing: an attacker needs the database *and* `SECRET_KEK`, which lives in
 * Workers secrets and never appears in the database, a backup, or a query result.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IV_BYTES = 12;
const VERSION = 'v1';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { fromBase64Url, toBase64Url };

async function importKek(kek: string): Promise<CryptoKey> {
  const raw = fromBase64Url(kek);
  if (raw.length !== 32) {
    throw new Error(`SECRET_KEK must decode to 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(kek: string, plaintext: string): Promise<string> {
  const key = await importKek(kek);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Returns `null` for anything that does not decrypt, rather than throwing into a request path. */
export async function openSecret(kek: string, sealed: string): Promise<string | null> {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  try {
    const key = await importKek(kek);
    const iv = fromBase64Url(parts[1]!);
    const ciphertext = fromBase64Url(parts[2]!);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext);
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
