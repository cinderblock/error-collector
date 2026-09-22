/**
 * The budget governor.
 *
 * This service has to run correctly on Workers Free *or* Paid without a rebuild, and
 * the limits have to be tunable at runtime. The goal is that exceeding capacity
 * **sheds detail** — it never produces a surprise bill, and it never burns through
 * D1's daily row-write allowance, which since 2026-09-01 hard-fails queries for the
 * whole account rather than throttling them.
 *
 * Usage is metered twice, for two different jobs. `usage_daily` in D1 is written
 * synchronously with every report, and the ingest path grades against *that* — it is
 * exact and current, which matters precisely in the case the governor exists for,
 * where a minute of staleness is thousands of reports. Analytics Engine gets one
 * data point per report as well, carrying `[1, d1RowsWritten, blobBytes]`; that copy
 * is the 90-day history behind the admin UI's charts, and it survives even when the
 * governor has stopped writing rows entirely.
 *
 * The cron tick publishes the current level to KV purely so the admin UI can show it
 * without recomputing.
 *
 * The interesting rule is at the top of the ladder: when nearly out of budget the
 * governor stops incrementing counters for issues it already knows about, but still
 * records *brand-new* issues. The last writes of the day are better spent on
 * discovering an unknown crash than on making a known crash's count more precise.
 */

import type { Env } from './env.js';
import { readSetting, writeSetting } from './storage/settings.js';

export type Plan = 'free' | 'paid';

/** Ordered least to most restrictive. */
export type GovernorLevel = 'full' | 'reduced' | 'issues-only' | 'counted' | 'rejecting';

export const GOVERNOR_LEVELS: readonly GovernorLevel[] = ['full', 'reduced', 'issues-only', 'counted', 'rejecting'];

export interface AccountBudget {
  requestsPerDay: number;
  d1RowWritesPerDay: number;
  aeDataPointsPerDay: number;
  r2BytesPerDay: number;
  r2BytesTotal: number;
}

export interface AppBudget {
  maxReportsPerDay: number;
  /** Event rows kept per issue. Beyond this the issue's counters still update. */
  maxSamplesPerIssue: number;
  /** After the first few, keep one occurrence in every N. */
  sampleEveryN: number;
  /** Always keep this many examples when an issue is new. */
  keepFirst: number;
  maxBodyBytes: number;
  maxBlobBytes: number;
  /** How long event samples and attachments are kept. */
  retentionDays: number;
  /**
   * How long a resolved or ignored issue is kept after it was last seen. Issues were
   * previously never pruned at all, so the table grew without bound.
   */
  resolvedRetentionDays: number;
  /**
   * How long an *open* issue may sit untouched before it is pruned. 0 disables it,
   * which is the default: an open issue is the triage surface, and quietly deleting
   * one is how a real bug gets forgotten. Opt in deliberately.
   */
  staleIssueDays: number;
}

export interface GovernorConfig {
  plan: Plan;
  account: AccountBudget;
  app: AppBudget;
}

export const GOVERNOR_SETTING_KEY = 'governor';
export const GOVERNOR_STATE_KV_KEY = 'governor:level';

/**
 * Free-plan budgets sit deliberately below Cloudflare's actual ceilings. The account
 * limits are shared with everything else running on it (the ops `uptime` worker's
 * per-minute cron, for one), so spending the entire allowance here would take those
 * down instead.
 */
export const PRESETS: Record<Plan, { account: AccountBudget; app: AppBudget }> = {
  free: {
    account: {
      requestsPerDay: 50_000, // of 100k account-wide
      d1RowWritesPerDay: 60_000, // of 100k
      aeDataPointsPerDay: 80_000, // of 100k
      r2BytesPerDay: 500 * 1024 * 1024,
      r2BytesTotal: 8 * 1024 * 1024 * 1024, // of 10 GB
    },
    app: {
      maxReportsPerDay: 20_000,
      maxSamplesPerIssue: 20,
      sampleEveryN: 50,
      keepFirst: 5,
      maxBodyBytes: 256 * 1024,
      maxBlobBytes: 3 * 1024 * 1024,
      retentionDays: 30,
      resolvedRetentionDays: 60,
      staleIssueDays: 0,
    },
  },
  paid: {
    account: {
      requestsPerDay: 5_000_000,
      d1RowWritesPerDay: 2_000_000,
      aeDataPointsPerDay: 5_000_000,
      r2BytesPerDay: 20 * 1024 * 1024 * 1024,
      r2BytesTotal: 200 * 1024 * 1024 * 1024,
    },
    app: {
      maxReportsPerDay: 1_000_000,
      maxSamplesPerIssue: 50,
      sampleEveryN: 100,
      keepFirst: 10,
      maxBodyBytes: 1024 * 1024,
      maxBlobBytes: 10 * 1024 * 1024,
      retentionDays: 90,
      resolvedRetentionDays: 180,
      staleIssueDays: 0,
    },
  },
};

/** Free is the default because it is the safe one — never infer the plan from a failure. */
export function defaultConfig(plan: Plan = 'free'): GovernorConfig {
  const preset = PRESETS[plan];
  return { plan, account: { ...preset.account }, app: { ...preset.app } };
}

export function loadGovernorConfig(env: Env): Promise<GovernorConfig> {
  return readSetting<GovernorConfig>(env, GOVERNOR_SETTING_KEY, defaultConfig());
}

export function saveGovernorConfig(env: Env, config: GovernorConfig): Promise<void> {
  return writeSetting(env, GOVERNOR_SETTING_KEY, config);
}

/**
 * Switching plan resets every budget to that plan's preset, discarding manual tuning.
 * That is deliberate: carrying free-tier numbers onto a paid plan would silently
 * throttle a service that no longer needs throttling, and the reverse would blow
 * through the free allowance.
 */
export function applyPreset(plan: Plan): GovernorConfig {
  return defaultConfig(plan);
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

export interface AccountUsage {
  requests: number;
  d1RowWrites: number;
  aeDataPoints: number;
  r2BytesToday: number;
  r2BytesTotal: number;
}

const THRESHOLDS: readonly (readonly [number, GovernorLevel])[] = [
  [1.0, 'rejecting'],
  [0.95, 'counted'],
  [0.8, 'issues-only'],
  [0.6, 'reduced'],
];

/** The single most-consumed dimension decides the level — budgets are not fungible. */
export function usageRatio(usage: AccountUsage, budget: AccountBudget): number {
  const ratios = [
    usage.requests / budget.requestsPerDay,
    usage.d1RowWrites / budget.d1RowWritesPerDay,
    usage.aeDataPoints / budget.aeDataPointsPerDay,
    usage.r2BytesToday / budget.r2BytesPerDay,
    usage.r2BytesTotal / budget.r2BytesTotal,
  ].filter(ratio => Number.isFinite(ratio) && ratio >= 0);

  return ratios.length > 0 ? Math.max(...ratios) : 0;
}

export function levelForRatio(ratio: number): GovernorLevel {
  for (const [threshold, level] of THRESHOLDS) {
    if (ratio >= threshold) return level;
  }
  return 'full';
}

export function levelFor(usage: AccountUsage, budget: AccountBudget): GovernorLevel {
  return levelForRatio(usageRatio(usage, budget));
}

export function describeLevel(level: GovernorLevel): string {
  switch (level) {
    case 'full':
      return 'Storing everything: issues, event samples and attachments.';
    case 'reduced':
      return 'Over 60% of budget: attachments accepted only from signed reports, fewer samples kept per issue.';
    case 'issues-only':
      return 'Over 80% of budget: issue counts still update, no new event samples or attachments.';
    case 'counted':
      return 'Over 95% of budget: only brand-new issues are recorded; known issues are counted in Analytics Engine alone.';
    case 'rejecting':
      return 'Budget exhausted: reports are refused with 429 until the daily reset.';
  }
}

// ---------------------------------------------------------------------------
// Per-report decision
// ---------------------------------------------------------------------------

export interface StorageDecision {
  /** False means answer 429 and write nothing at all. */
  accept: boolean;
  /** Insert or update the issue row. */
  storeIssue: boolean;
  /** Keep this occurrence as an event row. */
  storeEvent: boolean;
  /** Persist attachments to R2. */
  storeBlobs: boolean;
  /** Surfaced to the reporter so it can tell "counted" from "dropped". */
  reason: string;
}

export interface DecisionInput {
  level: GovernorLevel;
  budget: AppBudget;
  attested: boolean;
  /** Null when this fingerprint has never been seen. */
  existing: { count: number; sampleCount: number; lastRelease: string | null } | null;
  release: string | null;
  hasBlobs: boolean;
}

/**
 * Sampling policy for event rows:
 *
 * - The first `keepFirst` occurrences are always kept — early examples are what you
 *   actually read when triaging something new.
 * - After that, one in every `sampleEveryN`, until `maxSamplesPerIssue` is reached.
 * - One extra sample is allowed when the release changes, even at the cap, because
 *   "does this look different in 1.4.3?" is a question the counters cannot answer.
 *   That is bounded at twice the cap so a rapid release cadence cannot run away.
 */
function shouldSample(input: DecisionInput, maxSamples: number): boolean {
  const { existing, budget, release } = input;
  if (!existing) return true;

  const nextCount = existing.count + 1;
  if (existing.sampleCount < Math.min(budget.keepFirst, maxSamples)) return true;

  const releaseChanged = release !== null && release !== existing.lastRelease;
  if (releaseChanged && existing.sampleCount < maxSamples * 2) return true;

  if (existing.sampleCount >= maxSamples) return false;
  return nextCount % budget.sampleEveryN === 0;
}

export function decideStorage(input: DecisionInput): StorageDecision {
  const { level, budget, attested, existing, hasBlobs } = input;

  if (level === 'rejecting') {
    return { accept: false, storeIssue: false, storeEvent: false, storeBlobs: false, reason: 'budget exhausted' };
  }

  if (level === 'counted') {
    // Spend the last writes on novelty, not on refining a count we already have.
    const isNew = existing === null;
    return {
      accept: true,
      storeIssue: isNew,
      storeEvent: false,
      storeBlobs: false,
      reason: isNew ? 'near budget: new issue recorded, no samples' : 'near budget: counted in analytics only',
    };
  }

  if (level === 'issues-only') {
    return { accept: true, storeIssue: true, storeEvent: false, storeBlobs: false, reason: 'over budget: counts only' };
  }

  const maxSamples =
    level === 'reduced' ? Math.max(1, Math.floor(budget.maxSamplesPerIssue / 2)) : budget.maxSamplesPerIssue;
  const storeEvent = shouldSample(input, maxSamples);
  // Attachments are the most expensive thing per report, so they are the first
  // thing withdrawn from anonymous reporters when budget tightens.
  const storeBlobs = hasBlobs && storeEvent && (level === 'full' || attested);

  return {
    accept: true,
    storeIssue: true,
    storeEvent,
    storeBlobs,
    reason: storeEvent ? 'stored' : 'coalesced into existing issue',
  };
}

// ---------------------------------------------------------------------------
// Published level
// ---------------------------------------------------------------------------

export interface GovernorState {
  level: GovernorLevel;
  ratio: number;
  updatedAt: number;
  usage: AccountUsage;
}

/**
 * Read by the ingest hot path. `cacheTtl` means the common case costs a cached edge
 * read; a KV write only happens when the cron sees the level actually change, which
 * keeps this far under the free plan's 1 000 KV writes/day.
 */
export async function readGovernorState(env: Env): Promise<GovernorState | null> {
  return env.KV.get<GovernorState>(GOVERNOR_STATE_KV_KEY, { type: 'json', cacheTtl: 60 });
}

export async function publishGovernorState(env: Env, state: GovernorState): Promise<boolean> {
  const previous = await env.KV.get<GovernorState>(GOVERNOR_STATE_KV_KEY, { type: 'json' });
  if (previous && previous.level === state.level && Math.abs(previous.ratio - state.ratio) < 0.02) {
    return false;
  }
  await env.KV.put(GOVERNOR_STATE_KV_KEY, JSON.stringify(state));
  return true;
}
