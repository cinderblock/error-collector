import { describe, expect, it } from 'bun:test';
import {
  deriveIngestKey,
  generateAppSecret,
  generateReadToken,
  hashReadToken,
  isValidAppId,
  isValidChannel,
  parseAppSecret,
  parseIngestKey,
  signReport,
  timingSafeEqual,
  verifyIngestKey,
  verifyReportSignature,
} from './keys.js';

const SECRET = 'ecs_0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk';

describe('app secrets', () => {
  it('generates parseable 32-byte secrets', () => {
    const secret = generateAppSecret();
    expect(secret.startsWith('ecs_')).toBe(true);
    expect(parseAppSecret(secret)?.length).toBe(32);
  });

  it('rejects secrets with the wrong prefix or too little material', () => {
    expect(parseAppSecret('nope')).toBeNull();
    expect(parseAppSecret('ecs_abc')).toBeNull();
  });
});

describe('identifier validation', () => {
  it('accepts sensible app ids and rejects dots', () => {
    expect(isValidAppId('gate-manager')).toBe(true);
    expect(isValidAppId('xln')).toBe(true);
    // Dots in an app id would make an ingest key ambiguous to parse.
    expect(isValidAppId('my.app')).toBe(false);
    expect(isValidAppId('-leading')).toBe(false);
    expect(isValidAppId('Upper')).toBe(false);
    expect(isValidAppId('')).toBe(false);
  });

  it('accepts the channel shapes people actually use', () => {
    for (const channel of ['1.4.2', 'prod', 'staging', 'pr-812', 'a3f91c2', 'nightly+2026-09-21', '2.0.0-rc.1']) {
      expect(isValidChannel(channel)).toBe(true);
    }
    expect(isValidChannel('has space')).toBe(false);
    expect(isValidChannel('has\nnewline')).toBe(false);
    expect(isValidChannel('')).toBe(false);
  });
});

describe('ingest keys', () => {
  it('is deterministic for the same inputs', async () => {
    const a = await deriveIngestKey(SECRET, 'gate-manager', '1.4.2');
    const b = await deriveIngestKey(SECRET, 'gate-manager', '1.4.2');
    expect(a).toBe(b);
  });

  it('gives every channel a distinct key from one app secret', async () => {
    const keys = await Promise.all(
      ['1.4.2', '1.4.3', 'prod', 'staging'].map(channel => deriveIngestKey(SECRET, 'gate-manager', channel)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips a channel containing dots', async () => {
    // The whole reason for parsing from both ends: semver channels contain the
    // same character used as the field separator.
    const key = await deriveIngestKey(SECRET, 'gate-manager', '1.4.2');
    const parsed = parseIngestKey(key);
    expect(parsed).not.toBeNull();
    expect(parsed!.appId).toBe('gate-manager');
    expect(parsed!.channel).toBe('1.4.2');
  });

  it('round-trips a prerelease channel with several dots', async () => {
    const key = await deriveIngestKey(SECRET, 'xln', '2.0.0-rc.1+build.7');
    expect(parseIngestKey(key)!.channel).toBe('2.0.0-rc.1+build.7');
  });

  it('verifies a genuine key and reports the channel it encodes', async () => {
    const key = await deriveIngestKey(SECRET, 'gate-manager', 'prod');
    const verified = await verifyIngestKey(SECRET, key);
    expect(verified).toEqual({ appId: 'gate-manager', channel: 'prod', mac: key.split('.').pop()! });
  });

  it('refuses a channel the holder invented without the secret', async () => {
    // This is the property that makes zero-registration channel creation safe:
    // knowing a real key for 1.4.2 does not let you mint one for 9.9.9.
    const real = await deriveIngestKey(SECRET, 'gate-manager', '1.4.2');
    const forged = real.replace('1.4.2', '9.9.9');
    expect(await verifyIngestKey(SECRET, forged)).toBeNull();
  });

  it('refuses a key minted from a different app secret', async () => {
    const key = await deriveIngestKey(generateAppSecret(), 'gate-manager', 'prod');
    expect(await verifyIngestKey(SECRET, key)).toBeNull();
  });

  it('refuses a tampered MAC', async () => {
    const key = await deriveIngestKey(SECRET, 'gate-manager', 'prod');
    const flipped = `${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`;
    expect(await verifyIngestKey(SECRET, flipped)).toBeNull();
  });

  it('rejects malformed keys without throwing', () => {
    for (const bad of ['', 'ek1', 'ek1.', 'ek1.app', 'ek1.app.chan', 'ek2.app.chan.abcdefghjkmnpqrstvwxyz0123', 'x']) {
      expect(parseIngestKey(bad)).toBeNull();
    }
  });

  it('rejects an app id smuggled in with a dot', async () => {
    const key = await deriveIngestKey(SECRET, 'app', 'chan');
    expect(parseIngestKey(key.replace('ek1.app.', 'ek1.a.b.'))).not.toBeNull(); // now appId=a, channel=b.chan
    // ...but the MAC no longer matches, so verification still fails.
    expect(await verifyIngestKey(SECRET, key.replace('ek1.app.', 'ek1.a.b.'))).toBeNull();
  });

  it('refuses to derive for invalid identifiers', async () => {
    await expect(deriveIngestKey(SECRET, 'Bad Id', 'prod')).rejects.toThrow('invalid app id');
    await expect(deriveIngestKey(SECRET, 'ok', 'bad channel')).rejects.toThrow('invalid channel');
  });
});

describe('read tokens', () => {
  it('generates distinct tokens and stores only a digest', async () => {
    const token = generateReadToken();
    expect(token.startsWith('ert_')).toBe(true);
    expect(generateReadToken()).not.toBe(token);

    const digest = await hashReadToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token.slice(4));
    expect(await hashReadToken(token)).toBe(digest);
  });

  it('is not derivable from the app secret', async () => {
    // Read tokens must be independently revocable; deriving them from the app
    // secret would couple revocation to re-keying every deployed client.
    const token = generateReadToken();
    const ingest = await deriveIngestKey(SECRET, 'gate-manager', 'prod');
    expect(ingest).not.toContain(token.slice(4, 20));
  });
});

describe('report attestation', () => {
  const body = JSON.stringify({ message: 'boom' });

  it('accepts a signature made with the app secret', async () => {
    const now = 1_760_000_000;
    const signature = await signReport(SECRET, now, body);
    expect(await verifyReportSignature(SECRET, now, body, signature, now)).toBe(true);
  });

  it('rejects a modified body', async () => {
    const now = 1_760_000_000;
    const signature = await signReport(SECRET, now, body);
    expect(await verifyReportSignature(SECRET, now, `${body} `, signature, now)).toBe(false);
  });

  it('rejects a replayed signature once it is stale', async () => {
    const signed = 1_760_000_000;
    const signature = await signReport(SECRET, signed, body);
    expect(await verifyReportSignature(SECRET, signed, body, signature, signed + 299)).toBe(true);
    expect(await verifyReportSignature(SECRET, signed, body, signature, signed + 301)).toBe(false);
    expect(await verifyReportSignature(SECRET, signed, body, signature, signed - 301)).toBe(false);
  });

  it('rejects a signature from a different secret', async () => {
    const now = 1_760_000_000;
    const signature = await signReport(generateAppSecret(), now, body);
    expect(await verifyReportSignature(SECRET, now, body, signature, now)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('matches === for equality while ignoring length short-circuits', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
