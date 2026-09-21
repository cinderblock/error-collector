import { memo } from '../cache.js';
import type { Env } from '../env.js';
import type { AccountUsage } from '../governor.js';

export interface UsageRow {
  reports: number;
  stored: number;
  rows_written: number;
  blob_bytes: number;
  dropped: number;
  rejected: number;
}

const EMPTY: UsageRow = { reports: 0, stored: 0, rows_written: 0, blob_bytes: 0, dropped: 0, rejected: 0 };

export async function readUsage(env: Env, day: string, appId: string): Promise<UsageRow> {
  const row = await env.DB.prepare(
    'SELECT reports, stored, rows_written, blob_bytes, dropped, rejected FROM usage_daily WHERE day = ? AND app_id = ?',
  )
    .bind(day, appId)
    .first<UsageRow>();
  return row ?? { ...EMPTY };
}

/**
 * Total bytes currently in R2, from our own ledger rather than by listing the
 * bucket — a list is O(objects) in Class A operations, and this number only needs
 * to be right to within one cron tick.
 */
export function readStoredBytes(env: Env): Promise<number> {
  return memo('r2:total-bytes', 300, async () => {
    const row = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM blobs').first<{ total: number }>();
    return row?.total ?? 0;
  });
}

/**
 * The account-wide picture the governor grades against. `requests` and
 * `aeDataPoints` both come from the report count because every accepted report is
 * exactly one of each — keeping them as separate dimensions matters because their
 * budgets differ and either can be the binding constraint.
 */
export function toAccountUsage(totals: UsageRow, storedBytes: number): AccountUsage {
  return {
    requests: totals.reports + totals.rejected,
    d1RowWrites: totals.rows_written,
    aeDataPoints: totals.reports,
    r2BytesToday: totals.blob_bytes,
    r2BytesTotal: storedBytes,
  };
}

export async function readAccountUsage(env: Env, day: string): Promise<AccountUsage> {
  const [totals, storedBytes] = await Promise.all([readUsage(env, day, ''), readStoredBytes(env)]);
  return toAccountUsage(totals, storedBytes);
}

/**
 * Both usage rows the ingest path needs, in one query.
 *
 * Reading the account row here rather than trusting the cron-published level means
 * the governor grades against the real number instead of one up to a minute old.
 * That matters precisely in the case the governor exists for: a sudden flood, where
 * a minute of staleness is thousands of reports.
 */
export async function readUsagePair(
  env: Env,
  day: string,
  appId: string,
): Promise<{ app: UsageRow; account: UsageRow }> {
  const { results } = await env.DB.prepare(
    `SELECT app_id, reports, stored, rows_written, blob_bytes, dropped, rejected
     FROM usage_daily WHERE day = ? AND app_id IN (?, '')`,
  )
    .bind(day, appId)
    .all<UsageRow & { app_id: string }>();

  const find = (id: string) => results.find(row => row.app_id === id) ?? { ...EMPTY };
  return { app: find(appId), account: find('') };
}
