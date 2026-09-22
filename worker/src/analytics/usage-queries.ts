/**
 * Usage queries against the Analytics Engine SQL API.
 *
 * Query *construction* is kept pure and separate from execution so it can actually
 * be tested. AE has no local emulator — miniflare's binding is a no-op and there is
 * no offline SQL API — so asserting on the generated SQL is the only verification
 * available short of a live account, and it is worth having.
 *
 * Dialect notes, confirmed against the AE SQL reference rather than assumed:
 * columns are `timestamp`, `_sample_interval`, `index1`, `blob1..20`, `double1..20`;
 * the dataset name is the table; `toStartOfHour` / `toStartOfDay` / `toStartOfMinute`
 * and `toDateTime` are supported.
 */

import { USAGE_BLOBS, USAGE_DOUBLES, blobColumn, doubleColumn } from '@cinderblock/telemetry-collector-core';
import type { Env } from '../env.js';
import { WEIGHTED_COUNT, ident, lit, runSql, weightedSum } from './sql.js';

export type Interval = 'minute' | 'hour' | 'day';

const BUCKET: Record<Interval, string> = {
  minute: 'toStartOfMinute',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
};

export function parseInterval(value: string | null): Interval {
  return value === 'minute' || value === 'hour' || value === 'day' ? value : 'day';
}

/** The fixed blob slots a caller may group by. Custom dimensions live in variable
 *  slots and are deliberately not groupable — see the note in core's usage module. */
export const GROUPABLE = {
  event: USAGE_BLOBS.event,
  channel: USAGE_BLOBS.channel,
  release: USAGE_BLOBS.release,
  environment: USAGE_BLOBS.environment,
} as const;

export type GroupBy = keyof typeof GROUPABLE;

/**
 * `Object.hasOwn`, not `in`. The `in` operator walks the prototype chain, so
 * `'__proto__' in GROUPABLE` and `'toString' in GROUPABLE` are both true — meaning a
 * caller could pass either, pass the guard, and then index into `Object.prototype`.
 * The result is a column name built from an object or a function, i.e. malformed SQL
 * at best. Caught by a test; worth keeping the reason next to the fix.
 */
export function parseGroupBy(value: string | null): GroupBy {
  return value !== null && Object.hasOwn(GROUPABLE, value) ? (value as GroupBy) : 'event';
}

export interface UsageQuery {
  dataset: string;
  appId: string;
  /** Unix seconds. */
  since: number;
  event?: string | null;
  channel?: string | null;
  release?: string | null;
}

function conditions(query: UsageQuery): string[] {
  const where = [`index1 = ${lit(query.appId)}`, `timestamp >= toDateTime(${Math.floor(query.since)})`];

  if (query.event) where.push(`${blobColumn(USAGE_BLOBS.event)} = ${lit(query.event)}`);
  if (query.channel) where.push(`${blobColumn(USAGE_BLOBS.channel)} = ${lit(query.channel)}`);
  if (query.release) where.push(`${blobColumn(USAGE_BLOBS.release)} = ${lit(query.release)}`);

  return where;
}

export interface SeriesRow {
  bucket: string;
  events: number;
  value: number;
}

/** Totals per time bucket, for the chart. */
export function seriesSql(query: UsageQuery, interval: Interval): string {
  return [
    `SELECT ${BUCKET[interval]}(timestamp) AS bucket,`,
    `       ${WEIGHTED_COUNT} AS events,`,
    `       ${weightedSum(doubleColumn(USAGE_DOUBLES.value))} AS value`,
    `FROM ${ident(query.dataset)}`,
    `WHERE ${conditions(query).join(' AND ')}`,
    'GROUP BY bucket',
    'ORDER BY bucket',
    'LIMIT 1000',
  ].join('\n');
}

export interface BreakdownRow {
  key: string;
  events: number;
  value: number;
}

/** Leaderboard: which events (or channels, or releases) account for the volume. */
export function breakdownSql(query: UsageQuery, groupBy: GroupBy, limit = 50): string {
  const column = blobColumn(GROUPABLE[groupBy]);
  return [
    `SELECT ${column} AS key,`,
    `       ${WEIGHTED_COUNT} AS events,`,
    `       ${weightedSum(doubleColumn(USAGE_DOUBLES.value))} AS value`,
    `FROM ${ident(query.dataset)}`,
    `WHERE ${conditions(query).join(' AND ')}`,
    'GROUP BY key',
    'ORDER BY events DESC',
    `LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}`,
  ].join('\n');
}

/**
 * Per-(app, event, day) totals for a single day, for the retention rollup.
 *
 * AE keeps 90 days and offers no knob, so anything wanted beyond that has to be
 * copied into D1 before it ages out — and a rollup added later cannot recover what
 * has already expired, which is why this exists from the start.
 */
export function dailyRollupSql(dataset: string, appId: string, dayStart: number, dayEnd: number): string {
  return [
    `SELECT ${blobColumn(USAGE_BLOBS.event)} AS event,`,
    `       ${WEIGHTED_COUNT} AS events,`,
    `       ${weightedSum(doubleColumn(USAGE_DOUBLES.value))} AS value`,
    `FROM ${ident(dataset)}`,
    `WHERE index1 = ${lit(appId)}`,
    `  AND timestamp >= toDateTime(${Math.floor(dayStart)})`,
    `  AND timestamp < toDateTime(${Math.floor(dayEnd)})`,
    'GROUP BY event',
    'ORDER BY events DESC',
    'LIMIT 500',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function fetchSeries(env: Env, query: UsageQuery, interval: Interval): Promise<SeriesRow[]> {
  return runSql<SeriesRow>(env, seriesSql(query, interval)).then(result => result.data);
}

export function fetchBreakdown(env: Env, query: UsageQuery, groupBy: GroupBy, limit?: number): Promise<BreakdownRow[]> {
  return runSql<BreakdownRow>(env, breakdownSql(query, groupBy, limit)).then(result => result.data);
}
