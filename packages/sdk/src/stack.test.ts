import { describe, expect, it } from 'bun:test';
import { exceptionChain, isInApp, parseStack } from './stack.js';

const V8_STACK = `TypeError: Cannot read properties of undefined (reading 'open')
    at openGate (/src/gate.ts:117:9)
    at Object.handleRequest (/src/server.ts:42:5)
    at /src/anon.ts:5:3
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const MOZ_STACK = `openGate@https://app.example.com/assets/app.js:117:9
handleRequest@https://app.example.com/assets/app.js:42:5
@https://app.example.com/assets/app.js:5:3`;

describe('parseStack', () => {
  it('parses V8 frames', () => {
    const frames = parseStack(V8_STACK);
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)).toMatchObject({
      function: 'openGate',
      filename: '/src/gate.ts',
      lineno: 117,
      colno: 9,
      in_app: true,
    });
  });

  it('returns frames innermost-last, matching Sentry', () => {
    // Reversing is not cosmetic: grouping reads from the end, so getting this
    // backwards builds every fingerprint from `main()` and merges unrelated bugs.
    const frames = parseStack(V8_STACK);
    expect(frames.at(-1)?.function).toBe('openGate');
    expect(frames[0]?.filename).toBe('node:internal/process/task_queues');
  });

  it('skips the leading `Error: message` line', () => {
    expect(parseStack(V8_STACK).some(frame => frame.filename?.includes('Cannot read'))).toBe(false);
  });

  it('parses an anonymous V8 frame with no function name', () => {
    const anonymous = parseStack(V8_STACK).find(frame => frame.filename === '/src/anon.ts');
    expect(anonymous).toBeDefined();
    expect(anonymous?.function).toBeUndefined();
    expect(anonymous?.lineno).toBe(5);
  });

  it('strips V8 decorations from function names', () => {
    const frames = parseStack(`Error: x
    at async fetchThing (/src/a.ts:1:1)
    at new Widget (/src/b.ts:2:2)
    at Object.handler (/src/c.ts:3:3)`);
    expect(frames.map(frame => frame.function)).toEqual(['handler', 'Widget', 'fetchThing']);
  });

  it('parses Firefox and Safari frames', () => {
    const frames = parseStack(MOZ_STACK);
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)).toMatchObject({ function: 'openGate', lineno: 117, colno: 9 });
    expect(frames[0]?.function).toBeUndefined();
  });

  it('caps very deep stacks', () => {
    const deep = ['Error: x', ...Array.from({ length: 500 }, (_, i) => `    at f${i} (/src/a.ts:${i}:1)`)].join('\n');
    expect(parseStack(deep).length).toBeLessThanOrEqual(50);
  });

  it('returns nothing for absent or unrecognisable stacks', () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack('')).toEqual([]);
    expect(parseStack('not a stack at all')).toEqual([]);
  });
});

describe('isInApp', () => {
  it('marks dependency and runtime frames as not in-app', () => {
    // Grouping prefers in-app frames; without this, two different bugs that both
    // bottom out in the same framework function would merge.
    expect(isInApp('/app/node_modules/react/index.js')).toBe(false);
    expect(isInApp('node:internal/process/task_queues')).toBe(false);
    expect(isInApp('webpack-internal:///./src/x.js')).toBe(false);
    expect(isInApp('https://cdn.jsdelivr.net/npm/thing/dist.js')).toBe(false);
    expect(isInApp('/assets/vendor.4f3a1b.js')).toBe(false);
  });

  it('treats project files, and unknown files, as in-app', () => {
    expect(isInApp('/src/gate.ts')).toBe(true);
    expect(isInApp('https://app.example.com/assets/app.js')).toBe(true);
    expect(isInApp(undefined)).toBe(true);
  });
});

describe('exceptionChain', () => {
  it('walks `cause`, oldest first and the thrown error last', () => {
    // Sentry orders exception chains oldest to newest, and grouping keys on the
    // last entry — so a crash groups by what the app threw, not by whatever
    // low-level cause it wrapped.
    const root = new TypeError('the relay is undefined');
    const wrapper = new Error('could not open the gate', { cause: root });
    const chain = exceptionChain(wrapper);

    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ type: 'TypeError', value: 'the relay is undefined' });
    expect(chain.at(-1)?.value).toBe('could not open the gate');
  });

  it('bounds a cyclic or absurdly deep chain', () => {
    let error = new Error('0');
    for (let i = 1; i < 50; i++) error = new Error(String(i), { cause: error });
    expect(exceptionChain(error).length).toBeLessThanOrEqual(5);
  });

  it('describes non-Error throws instead of producing [object Object]', () => {
    expect(exceptionChain('just a string')[0]).toMatchObject({ type: 'Error', value: 'just a string' });
    expect(exceptionChain({ code: 500 })[0]?.value).toBe('{"code":500}');
    expect(exceptionChain(null)).toEqual([]);
    expect(exceptionChain(undefined)).toEqual([]);
  });
});
