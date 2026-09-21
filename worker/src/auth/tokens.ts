/**
 * Session cookies and device-invite links.
 *
 * Sessions are random ids looked up in D1 rather than self-contained signed tokens.
 * A signed token avoids a database read, but it cannot be revoked before it expires
 * — and the entire point of having a device list is that deleting a device logs it
 * out *now*. One indexed read per admin request is a cheap price for that.
 */

import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';

export const SESSION_COOKIE = 'ec_session';
export const SESSION_TTL_SECONDS = 90 * 86_400;
const INVITE_TTL_SECONDS = 15 * 60;

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Return type is pinned to `ArrayBuffer` rather than `ArrayBufferLike`: the WebAuthn
// verifier will not accept a view that might be backed by a SharedArrayBuffer.
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomId(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(env: Env, deviceId: string): Promise<string> {
  const id = randomId();
  const now = nowSeconds();
  await env.DB.prepare('INSERT INTO sessions (id, owner_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, env.OWNER_ID, deviceId, now, now + SESSION_TTL_SECONDS)
    .run();
  return id;
}

export interface Session {
  id: string;
  deviceId: string;
  deviceName: string;
}

export async function readSession(env: Env, request: Request): Promise<Session | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;

  const row = await env.DB.prepare(
    `SELECT s.id, s.device_id, d.name AS device_name
     FROM sessions s JOIN devices d ON d.id = s.device_id
     WHERE s.id = ? AND s.owner_id = ? AND s.expires_at > ?`,
  )
    .bind(id, env.OWNER_ID, nowSeconds())
    .first<{ id: string; device_id: string; device_name: string }>();

  return row ? { id: row.id, deviceId: row.device_id, deviceName: row.device_name } : null;
}

export async function destroySession(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/**
 * `SameSite=Strict` rather than `Lax`: nothing here is meant to be reachable by
 * following a link from elsewhere, so there is no usability cost, and it removes
 * CSRF as a category rather than mitigating it.
 */
export function sessionCookie(id: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', secure ? 'Secure' : '', 'Max-Age=0']
    .filter(Boolean)
    .join('; ');
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device invites
// ---------------------------------------------------------------------------

/**
 * A single-use link letting an already-trusted device enrol another one. This is
 * what keeps `BOOTSTRAP_TOKEN` a once-in-the-service's-life credential rather than
 * a standing password that has to exist for every new phone.
 */
export async function createInvite(env: Env): Promise<{ id: string; expiresAt: number }> {
  const id = randomId(24);
  const now = nowSeconds();
  const expiresAt = now + INVITE_TTL_SECONDS;

  await env.DB.prepare('INSERT INTO device_invites (id, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, env.OWNER_ID, now, expiresAt)
    .run();

  return { id, expiresAt };
}

/** Claims atomically, so a link raced by two tabs enrols exactly one device. */
export async function claimInvite(env: Env, id: string): Promise<boolean> {
  const now = nowSeconds();
  const row = await env.DB.prepare(
    `UPDATE device_invites SET used_at = ?
     WHERE id = ? AND owner_id = ? AND used_at IS NULL AND expires_at > ?
     RETURNING id`,
  )
    .bind(now, id, env.OWNER_ID, now)
    .first<{ id: string }>();

  return row !== null;
}
