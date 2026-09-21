import { describe, expect, it } from 'bun:test';
import { computeFingerprint, culpritFor, normalizeMessage, resolveFingerprint, titleFor } from './fingerprint.js';
import type { StackFrame, StoredEvent } from './types.js';

const APP = 'gate-manager';

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    event_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'error',
    level: 'error',
    timestamp: 1_760_000_000,
    tags: {},
    extra: {},
    contexts: {},
    ...overrides,
  };
}

/** Frames are oldest-first / innermost-last, matching Sentry's ordering. */
function crash(frames: StackFrame[], value = 'Cannot read property of undefined'): StoredEvent {
  return event({ exception: { values: [{ type: 'TypeError', value, stacktrace: { frames } }] } });
}

const STACK: StackFrame[] = [
  { function: 'main', filename: '/src/main.ts', lineno: 10 },
  { function: 'handleRequest', filename: '/src/server.ts', lineno: 42 },
  { function: 'openGate', filename: '/src/gate.ts', lineno: 117 },
];

describe('normalizeMessage', () => {
  it('collapses the parts that vary per occurrence', () => {
    expect(normalizeMessage('user 12345 not found')).toBe('user <n> not found');
    expect(normalizeMessage('request 550e8400-e29b-41d4-a716-446655440000 failed')).toBe('request <uuid> failed');
    expect(normalizeMessage('fetch https://api.example.com/v1/x?y=1 failed')).toBe('fetch <url> failed');
    expect(normalizeMessage('at address 0xdeadbeef')).toBe('at address <hex>');
    expect(normalizeMessage('token a3f91c2b4d5e6f70 rejected')).toBe('token <hex> rejected');
  });

  it('keeps quoted detail, which is usually the distinguishing part', () => {
    // `'foo'` vs `'bar'` are genuinely different bugs; collapsing them would merge
    // unrelated crashes into one unreadable issue.
    expect(normalizeMessage("Cannot read property 'foo' of undefined")).toContain("'foo'");
  });

  it('collapses whitespace so reformatting does not regroup', () => {
    expect(normalizeMessage('  a   b\n\tc  ')).toBe('a b c');
  });
});

describe('fingerprint stability', () => {
  it('is unchanged when only the release differs', async () => {
    // An issue must span versions so the UI can say "started in 1.4.2, still
    // happening in 1.4.4". Release is tracked on the issue, not in the grouping key.
    const a = await computeFingerprint({ ...crash(STACK), release: '1.4.2' }, APP, 'seed-a');
    const b = await computeFingerprint({ ...crash(STACK), release: '1.4.4' }, APP, 'seed-b');
    expect(a).toBe(b);
  });

  it('is unchanged when line and column numbers shift', async () => {
    const moved = STACK.map(frame => ({ ...frame, lineno: (frame.lineno ?? 0) + 7, colno: 3 }));
    expect(await computeFingerprint(crash(STACK), APP, 's')).toBe(await computeFingerprint(crash(moved), APP, 's'));
  });

  it('is unchanged when a bundle hash changes', async () => {
    const before = crash([{ function: 'openGate', filename: '/assets/app.4f3a1b.js' }]);
    const after = crash([{ function: 'openGate', filename: '/assets/app.9cd02e.js' }]);
    expect(await computeFingerprint(before, APP, 's')).toBe(await computeFingerprint(after, APP, 's'));
  });

  it('is unchanged when the message varies only in ids', async () => {
    const a = crash([], 'user 111 not found');
    const b = crash([], 'user 222 not found');
    expect(await computeFingerprint(a, APP, 's')).toBe(await computeFingerprint(b, APP, 's'));
  });

  it('differs for a different innermost function', async () => {
    const other = [...STACK.slice(0, 2), { function: 'closeGate', filename: '/src/gate.ts', lineno: 130 }];
    expect(await computeFingerprint(crash(STACK), APP, 's')).not.toBe(await computeFingerprint(crash(other), APP, 's'));
  });

  it('differs for a different exception type on the same stack', async () => {
    const typeError = crash(STACK);
    const rangeError = event({
      exception: { values: [{ type: 'RangeError', value: 'x', stacktrace: { frames: STACK } }] },
    });
    expect(await computeFingerprint(typeError, APP, 's')).not.toBe(await computeFingerprint(rangeError, APP, 's'));
  });

  it('separates apps that produce identical crashes', async () => {
    expect(await computeFingerprint(crash(STACK), 'app-one', 's')).not.toBe(
      await computeFingerprint(crash(STACK), 'app-two', 's'),
    );
  });

  it('ignores vendor frames when in-app frames exist', async () => {
    const withVendor = [
      { function: 'reactDispatch', filename: '/vendor/react.js', in_app: false },
      ...STACK,
      { function: 'zoneWrap', filename: '/vendor/zone.js', in_app: false },
    ];
    expect(await computeFingerprint(crash(withVendor), APP, 's')).toBe(
      await computeFingerprint(crash(STACK), APP, 's'),
    );
  });

  it('falls back to all frames when nothing is marked in-app', async () => {
    const allVendor = STACK.map(frame => ({ ...frame, in_app: false }));
    // Still groups deterministically rather than collapsing to "no frames".
    expect(await computeFingerprint(crash(allVendor), APP, 's')).toBe(
      await computeFingerprint(crash(allVendor), APP, 's'),
    );
    expect(await computeFingerprint(crash(allVendor), APP, 's')).not.toBe(
      await computeFingerprint(crash([]), APP, 's'),
    );
  });
});

describe('grouping policy', () => {
  it('never coalesces feedback', async () => {
    // Two people reporting "the button is broken" are two things to read.
    const feedback = event({ kind: 'feedback', level: 'info', message: 'the button is broken' });
    expect(await computeFingerprint(feedback, APP, 'submission-1')).not.toBe(
      await computeFingerprint(feedback, APP, 'submission-2'),
    );
  });

  it('lets an explicit fingerprint override the derived one', async () => {
    const derived = await resolveFingerprint(crash(STACK), APP, 's');
    const overridden = await resolveFingerprint(crash(STACK), APP, 's', ['gate-timeout']);
    expect(overridden).not.toBe(derived);
    // ...and the override is itself stable across unrelated stacks.
    expect(overridden).toBe(await resolveFingerprint(crash([]), APP, 'other', ['gate-timeout']));
  });

  it('keeps overrides scoped to one app', async () => {
    expect(await resolveFingerprint(crash(STACK), 'app-one', 's', ['same'])).not.toBe(
      await resolveFingerprint(crash(STACK), 'app-two', 's', ['same']),
    );
  });
});

describe('labels', () => {
  it('titles an exception with type and value', () => {
    expect(titleFor(crash(STACK))).toBe('TypeError: Cannot read property of undefined');
  });

  it('titles a message-only event with its message', () => {
    expect(titleFor(event({ message: 'disk almost full' }))).toBe('disk almost full');
    expect(titleFor(event())).toBe('(no message)');
  });

  it('points the culprit at the innermost in-app frame', () => {
    expect(culpritFor(crash(STACK))).toBe('openGate (gate.ts)');
    expect(culpritFor(event({ message: 'no stack here' }))).toBeNull();
  });
});
