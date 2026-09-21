import { describe, expect, it } from 'bun:test';
import {
  type AccountUsage,
  type DecisionInput,
  type GovernorLevel,
  PRESETS,
  applyPreset,
  decideStorage,
  defaultConfig,
  levelFor,
  levelForRatio,
  usageRatio,
} from './governor.js';

const BUDGET = PRESETS.free.account;
const APP = PRESETS.free.app;

function usage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return { requests: 0, d1RowWrites: 0, aeDataPoints: 0, r2BytesToday: 0, r2BytesTotal: 0, ...overrides };
}

function decision(overrides: Partial<DecisionInput> = {}) {
  const input: DecisionInput = {
    level: 'full',
    budget: APP,
    attested: false,
    existing: null,
    release: null,
    hasBlobs: false,
    ...overrides,
  };
  return decideStorage(input);
}

describe('presets', () => {
  it('defaults to free, the safe plan', () => {
    expect(defaultConfig().plan).toBe('free');
  });

  it('keeps free budgets below Cloudflare ceilings so other workers still fit', () => {
    // The account allowances are shared with everything else on the account, so
    // claiming all of them here would break the ops uptime worker instead.
    expect(BUDGET.requestsPerDay).toBeLessThan(100_000);
    expect(BUDGET.d1RowWritesPerDay).toBeLessThan(100_000);
    expect(BUDGET.aeDataPointsPerDay).toBeLessThan(100_000);
    expect(BUDGET.r2BytesTotal).toBeLessThan(10 * 1024 * 1024 * 1024);
  });

  it('gives paid strictly more room on every dimension', () => {
    for (const key of Object.keys(BUDGET) as (keyof typeof BUDGET)[]) {
      expect(PRESETS.paid.account[key]).toBeGreaterThan(BUDGET[key]);
    }
  });

  it('replaces tuned budgets wholesale when the plan changes', () => {
    expect(applyPreset('paid').account).toEqual(PRESETS.paid.account);
    expect(applyPreset('free').app).toEqual(PRESETS.free.app);
  });
});

describe('usageRatio', () => {
  it('is driven by the single most-consumed dimension', () => {
    // Budgets are not fungible — plenty of spare R2 does not buy more D1 writes.
    const ratio = usageRatio(usage({ requests: 100, d1RowWrites: BUDGET.d1RowWritesPerDay * 0.9 }), BUDGET);
    expect(ratio).toBeCloseTo(0.9, 5);
  });

  it('counts cumulative R2 storage, not just today', () => {
    const ratio = usageRatio(usage({ r2BytesTotal: BUDGET.r2BytesTotal * 0.97 }), BUDGET);
    expect(ratio).toBeCloseTo(0.97, 5);
  });

  it('is zero for a fresh day', () => {
    expect(usageRatio(usage(), BUDGET)).toBe(0);
  });
});

describe('levelForRatio', () => {
  const cases: [number, GovernorLevel][] = [
    [0, 'full'],
    [0.59, 'full'],
    [0.6, 'reduced'],
    [0.79, 'reduced'],
    [0.8, 'issues-only'],
    [0.94, 'issues-only'],
    [0.95, 'counted'],
    [0.99, 'counted'],
    [1, 'rejecting'],
    [12, 'rejecting'],
  ];

  for (const [ratio, expected] of cases) {
    it(`maps ${ratio} to ${expected}`, () => {
      expect(levelForRatio(ratio)).toBe(expected);
    });
  }

  it('reaches the same answer through levelFor', () => {
    expect(levelFor(usage({ d1RowWrites: BUDGET.d1RowWritesPerDay }), BUDGET)).toBe('rejecting');
  });
});

describe('decideStorage', () => {
  it('stores everything when there is budget to spare', () => {
    expect(decision({ hasBlobs: true })).toMatchObject({
      accept: true,
      storeIssue: true,
      storeEvent: true,
      storeBlobs: true,
    });
  });

  it('refuses outright once the budget is gone', () => {
    const result = decision({ level: 'rejecting', hasBlobs: true });
    expect(result.accept).toBe(false);
    expect(result.storeIssue).toBe(false);
    expect(result.storeEvent).toBe(false);
    expect(result.storeBlobs).toBe(false);
  });

  it('withdraws attachments from anonymous reporters first', () => {
    // Attachments are the most expensive thing per report, and an unsigned one
    // came from a world-open endpoint.
    expect(decision({ level: 'reduced', hasBlobs: true, attested: false }).storeBlobs).toBe(false);
    expect(decision({ level: 'reduced', hasBlobs: true, attested: true }).storeBlobs).toBe(true);
  });

  it('keeps counts accurate but stops sampling at issues-only', () => {
    const result = decision({ level: 'issues-only', hasBlobs: true, attested: true });
    expect(result).toMatchObject({ accept: true, storeIssue: true, storeEvent: false, storeBlobs: false });
  });

  describe('at the top of the ladder', () => {
    it('still records a brand-new issue', () => {
      // The last writes of the day are worth more spent on discovering an unknown
      // crash than on refining the count of a known one.
      const result = decision({ level: 'counted', existing: null });
      expect(result.accept).toBe(true);
      expect(result.storeIssue).toBe(true);
    });

    it('writes nothing for an issue already known', () => {
      const result = decision({
        level: 'counted',
        existing: { count: 900, sampleCount: 5, lastRelease: '1.0.0' },
      });
      expect(result.accept).toBe(true);
      expect(result.storeIssue).toBe(false);
      expect(result.reason).toContain('analytics only');
    });
  });
});

describe('sampling policy', () => {
  const existing = (count: number, sampleCount: number, lastRelease: string | null = '1.0.0') => ({
    count,
    sampleCount,
    lastRelease,
  });

  it('always keeps the first occurrence of a new issue', () => {
    expect(decision({ existing: null }).storeEvent).toBe(true);
  });

  it('keeps every one of the first few examples', () => {
    for (let seen = 0; seen < APP.keepFirst; seen++) {
      expect(decision({ existing: existing(seen, seen) }).storeEvent).toBe(true);
    }
  });

  it('then keeps only one in every N', () => {
    const past = APP.keepFirst + 1;
    // count+1 must be a multiple of sampleEveryN to be kept.
    expect(decision({ existing: existing(APP.sampleEveryN - 1, past) }).storeEvent).toBe(true);
    expect(decision({ existing: existing(APP.sampleEveryN, past) }).storeEvent).toBe(false);
  });

  it('stops adding rows once the per-issue cap is reached', () => {
    // A flood must cost one counter update, not an unbounded pile of rows.
    const capped = existing(APP.sampleEveryN * 100 - 1, APP.maxSamplesPerIssue);
    expect(decision({ existing: capped }).storeEvent).toBe(false);
  });

  it('halves the cap under reduced level', () => {
    const half = Math.floor(APP.maxSamplesPerIssue / 2);
    const atHalf = existing(APP.sampleEveryN * 10 - 1, half);
    expect(decision({ level: 'reduced', existing: atHalf }).storeEvent).toBe(false);
    expect(decision({ level: 'full', existing: atHalf }).storeEvent).toBe(true);
  });

  it('grabs a fresh sample when the release changes, even at the cap', () => {
    // "Does this look different in 1.4.3?" is not a question counters can answer.
    const capped = existing(5_000, APP.maxSamplesPerIssue, '1.4.2');
    expect(decision({ existing: capped, release: '1.4.2' }).storeEvent).toBe(false);
    expect(decision({ existing: capped, release: '1.4.3' }).storeEvent).toBe(true);
  });

  it('bounds the release exemption so a fast cadence cannot run away', () => {
    const wayOver = existing(5_000, APP.maxSamplesPerIssue * 2, '1.4.2');
    expect(decision({ existing: wayOver, release: '9.9.9' }).storeEvent).toBe(false);
  });
});
