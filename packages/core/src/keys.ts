/**
 * Credentials.
 *
 * Three distinct kinds of key material, deliberately not derived from one another:
 *
 * 1. **App secret** (`ecs_…`) — 32 random bytes, held by the developer and by CI.
 *    Never shipped to a client. Everything else about an app hangs off this.
 * 2. **Ingest key** (`ek1.app.channel.mac`) — HMAC-derived from the app secret.
 *    **Public by design**: it is baked into shipped client bundles, so it identifies
 *    and routes, it does not authenticate. Its value is that it is *derivable
 *    offline* — a build computes its own key with no API call, and the server
 *    verifies it with no prior registration, so a new version provisions itself on
 *    its first report.
 * 3. **Read token** (`ert_…`) — 32 random bytes, independent of the app secret,
 *    stored server-side only as a SHA-256 hash.
 *
 * Why (3) is not derived from (1): the two have opposite lifecycle requirements. An
 * ingest key is compiled into binaries already in users' hands and is effectively
 * unrotatable; a read token lives in agent and CI environments, which is where
 * credentials actually leak from, and must be cheap to revoke. Deriving both from one
 * secret would mean revoking a leaked agent token forces re-keying every deployed
 * app instance.
 */

import { base32Decode, base32Encode, base32Length } from './base32.js';

export const INGEST_KEY_PREFIX = 'ek1';
export const APP_SECRET_PREFIX = 'ecs_';
export const READ_TOKEN_PREFIX = 'ert_';

const SECRET_BYTES = 32;
const TOKEN_BYTES = 32;
/** 128 bits is ample for a public, unguessable identifier. */
const MAC_BYTES = 16;
const MAC_CHARS = base32Length(MAC_BYTES);

/** Default tolerance for attestation timestamp skew. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * App ids may not contain `.` — that is what makes an ingest key unambiguously
 * parseable even though channels (`1.4.2`) routinely do.
 */
const APP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Wide enough for semver, git SHAs, `pr-812`, `staging`, `nightly+2026-09-21`. */
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function isValidAppId(value: string): boolean {
  return APP_ID_RE.test(value);
}

export function isValidChannel(value: string): boolean {
  return CHANNEL_RE.test(value);
}

// ---------------------------------------------------------------------------
// Random material
// ---------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function generateAppSecret(): string {
  return APP_SECRET_PREFIX + base32Encode(randomBytes(SECRET_BYTES));
}

export function generateReadToken(): string {
  return READ_TOKEN_PREFIX + base32Encode(randomBytes(TOKEN_BYTES));
}

/** Decodes an `ecs_…` secret to raw bytes. Returns `null` if malformed. */
export function parseAppSecret(secret: string): Uint8Array | null {
  if (!secret.startsWith(APP_SECRET_PREFIX)) return null;
  const bytes = base32Decode(secret.slice(APP_SECRET_PREFIX.length));
  if (!bytes || bytes.length < SECRET_BYTES) return null;
  return bytes.slice(0, SECRET_BYTES);
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  // Copied into a fresh buffer so the type is `Uint8Array<ArrayBuffer>` rather than
  // `<ArrayBufferLike>`; `importKey` will not accept a possibly-shared buffer.
  const material = new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Constant-time string comparison. Compares every character of the longer input so
 * the loop count does not reveal where the first difference is; the length check is
 * folded into the result rather than short-circuiting.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Ingest keys
// ---------------------------------------------------------------------------

/**
 * Domain-separated HMAC context. The `\n` separators are unambiguous because
 * `isValidAppId` and `isValidChannel` both exclude newlines, and the version tag
 * means a future key format cannot collide with this one.
 */
function ingestContext(appId: string, channel: string): string {
  return `error-collector.ingest.v1\n${appId}\n${channel}`;
}

export interface ParsedIngestKey {
  appId: string;
  channel: string;
  mac: string;
}

/**
 * `ek1.<appId>.<channel>.<mac>` — readable on purpose. Someone who finds this string
 * in an app bundle should be able to tell at a glance that it is a routing
 * identifier and not a leaked credential.
 *
 * Parsed from both ends because the channel is the only field allowed to contain
 * `.`: the MAC is a fixed width at the tail, the app id runs to the first `.`, and
 * whatever is between them is the channel.
 */
export function parseIngestKey(key: string): ParsedIngestKey | null {
  const prefix = `${INGEST_KEY_PREFIX}.`;
  if (!key.startsWith(prefix)) return null;

  const rest = key.slice(prefix.length);
  // Need at least `a.b.` before a full-width MAC.
  if (rest.length < MAC_CHARS + 4) return null;
  if (rest[rest.length - MAC_CHARS - 1] !== '.') return null;

  const mac = rest.slice(-MAC_CHARS);
  const head = rest.slice(0, -(MAC_CHARS + 1));

  const split = head.indexOf('.');
  if (split <= 0 || split === head.length - 1) return null;

  const appId = head.slice(0, split);
  const channel = head.slice(split + 1);

  if (!isValidAppId(appId) || !isValidChannel(channel)) return null;
  if (base32Decode(mac) === null) return null;

  return { appId, channel, mac };
}

export async function deriveIngestKey(appSecret: string | Uint8Array, appId: string, channel: string): Promise<string> {
  const secret = typeof appSecret === 'string' ? parseAppSecret(appSecret) : appSecret;
  if (!secret) throw new Error('invalid app secret');
  if (!isValidAppId(appId)) throw new Error(`invalid app id: ${JSON.stringify(appId)}`);
  if (!isValidChannel(channel)) throw new Error(`invalid channel: ${JSON.stringify(channel)}`);

  const mac = await hmac(secret, ingestContext(appId, channel));
  return `${INGEST_KEY_PREFIX}.${appId}.${channel}.${base32Encode(mac.slice(0, MAC_BYTES))}`;
}

/**
 * Verifies a presented ingest key against the app's secret.
 *
 * A `true` result does **not** mean the caller is trusted — the key is public. It
 * means the key is well-formed and really was minted from this app's secret, which
 * is what lets the server accept a never-before-seen channel without any prior
 * registration while still refusing channels invented by a stranger.
 */
export async function verifyIngestKey(appSecret: string | Uint8Array, key: string): Promise<ParsedIngestKey | null> {
  const parsed = parseIngestKey(key);
  if (!parsed) return null;

  const expected = await deriveIngestKey(appSecret, parsed.appId, parsed.channel);
  return timingSafeEqual(expected, key) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Read tokens
// ---------------------------------------------------------------------------

/** Read tokens are stored only as this digest, so a database leak yields nothing usable. */
export function hashReadToken(token: string): Promise<string> {
  return sha256Hex(`error-collector.read-token.v1\n${token}`);
}

// ---------------------------------------------------------------------------
// Optional report attestation
// ---------------------------------------------------------------------------

/**
 * Reporters that can legitimately hold the app secret — server-side apps, CLIs, CI
 * jobs, dev machines — may sign their reports. Signed reports are stored with
 * `attested = 1`, which is what makes a world-open ingest endpoint comfortable to
 * live with: triage can filter to reports that provably came from us.
 *
 * The timestamp is inside the signed material so a captured request cannot be
 * replayed indefinitely.
 */
export async function signReport(appSecret: string | Uint8Array, timestamp: number, body: string): Promise<string> {
  const secret = typeof appSecret === 'string' ? parseAppSecret(appSecret) : appSecret;
  if (!secret) throw new Error('invalid app secret');

  const mac = await hmac(secret, `error-collector.report.v1\n${timestamp}\n${body}`);
  return `v1=${toHex(mac)}`;
}

export async function verifyReportSignature(
  appSecret: string | Uint8Array,
  timestamp: number,
  body: string,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxSkewSeconds: number = SIGNATURE_MAX_SKEW_SECONDS,
): Promise<boolean> {
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) return false;

  const expected = await signReport(appSecret, timestamp, body);
  return timingSafeEqual(expected, signature);
}
