/**
 * Passkey registration and authentication.
 *
 * Single owner, so there is one WebAuthn user and the credential list is the device
 * list. Attestation is `none` — attestation proves *which model* of authenticator
 * was used, which matters when an enterprise must exclude certain hardware and not
 * at all here, and asking for it adds a privacy prompt on some platforms for no
 * benefit.
 *
 * The RP id and origin are derived from the request URL rather than configured. That
 * is correct on the custom domain and makes `localhost` development work unchanged,
 * which matters because WebAuthn cannot be tested any other way.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Env } from '../env.js';
import { nowSeconds } from '../env.js';
import { base64url, fromBase64url } from './tokens.js';

const CHALLENGE_TTL_SECONDS = 300;

export interface DeviceRow {
  id: string;
  owner_id: string;
  name: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: number;
  last_used_at: number | null;
}

function relyingParty(url: URL): { rpID: string; origin: string } {
  return { rpID: url.hostname, origin: url.origin };
}

export function listDevices(env: Env): Promise<D1Result<DeviceRow>> {
  return env.DB.prepare('SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at')
    .bind(env.OWNER_ID)
    .all<DeviceRow>();
}

export async function countDevices(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE owner_id = ?')
    .bind(env.OWNER_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function storeChallenge(env: Env, kind: string, challenge: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = nowSeconds();
  await env.DB.prepare('INSERT INTO auth_state (id, kind, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, kind, challenge, now, now + CHALLENGE_TTL_SECONDS)
    .run();
  return id;
}

/** Claims atomically: a challenge that could be used twice is a replay waiting to happen. */
async function claimChallenge(env: Env, id: string, kind: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `UPDATE auth_state SET used = 1
     WHERE id = ? AND kind = ? AND used = 0 AND expires_at > ?
     RETURNING value`,
  )
    .bind(id, kind, nowSeconds())
    .first<{ value: string }>();
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registrationOptions(env: Env, url: URL) {
  const { rpID } = relyingParty(url);
  const { results: devices } = await listDevices(env);

  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME,
    rpID,
    userID: new Uint8Array(new TextEncoder().encode(env.OWNER_ID)),
    userName: env.OWNER_NAME,
    attestationType: 'none',
    // Stops the same authenticator being enrolled twice, which otherwise produces
    // two entries that look like two devices and revoke as one.
    excludeCredentials: devices.map(device => ({ id: device.id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  return { options, stateId: await storeChallenge(env, 'registration', options.challenge) };
}

export async function verifyRegistration(
  env: Env,
  url: URL,
  stateId: string,
  name: string,
  response: RegistrationResponseJSON,
): Promise<DeviceRow> {
  const challenge = await claimChallenge(env, stateId, 'registration');
  if (challenge === null) throw new Error('challenge expired or already used');

  const { rpID, origin } = relyingParty(url);
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verified || !registrationInfo) throw new Error('registration not verified');

  const credential = registrationInfo.credential;
  const device: DeviceRow = {
    id: credential.id,
    owner_id: env.OWNER_ID,
    name,
    public_key: base64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    created_at: nowSeconds(),
    last_used_at: null,
  };

  await env.DB.prepare(
    `INSERT INTO devices (id, owner_id, name, public_key, counter, transports, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      device.id,
      device.owner_id,
      device.name,
      device.public_key,
      device.counter,
      device.transports,
      device.created_at,
    )
    .run();

  return device;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function authenticationOptions(env: Env, url: URL) {
  const { rpID } = relyingParty(url);
  const { results: devices } = await listDevices(env);

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: devices.map(device => ({
      id: device.id,
      transports: device.transports ? (JSON.parse(device.transports) as AuthenticatorTransport[]) : undefined,
    })),
  });

  return { options, stateId: await storeChallenge(env, 'authentication', options.challenge) };
}

type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export async function verifyAuthentication(
  env: Env,
  url: URL,
  stateId: string,
  response: AuthenticationResponseJSON,
): Promise<DeviceRow> {
  const challenge = await claimChallenge(env, stateId, 'authentication');
  if (challenge === null) throw new Error('challenge expired or already used');

  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND owner_id = ?')
    .bind(response.id, env.OWNER_ID)
    .first<DeviceRow>();
  if (!device) throw new Error('unknown credential');

  const { rpID, origin } = relyingParty(url);
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: device.id,
      publicKey: fromBase64url(device.public_key),
      counter: device.counter,
      transports: device.transports ? (JSON.parse(device.transports) as AuthenticatorTransport[]) : undefined,
    },
  });
  if (!verified) throw new Error('authentication not verified');

  await env.DB.prepare('UPDATE devices SET counter = ?, last_used_at = ? WHERE id = ?')
    .bind(authenticationInfo.newCounter, nowSeconds(), device.id)
    .run();

  return device;
}

/** Deleting a device cascades to its sessions, so revocation takes effect immediately. */
export async function deleteDevice(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE device_id = ?').bind(id),
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND owner_id = ?').bind(id, env.OWNER_ID),
  ]);
}

export async function pruneAuthState(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_state WHERE expires_at < ?').bind(nowSeconds()).run();
}
