import { describe, expect, it } from 'bun:test';
import {
  breakdownSql,
  dailyRollupSql,
  parseGroupBy,
  parseInterval,
  seriesSql,
  type UsageQuery,
} from './usage-queries.js';

const query: UsageQuery = { dataset: 'telemetry_usage', appId: 'gate-manager', since: 1_790_000_000 };

describe('parsing', () => {
  it('defaults to a day interval and event grouping', () => {
    expect(parseInterval(null)).toBe('day');
    expect(parseInterval('nonsense')).toBe('day');
    expect(parseGroupBy(null)).toBe('event');
    expect(parseGroupBy('; DROP TABLE x')).toBe('event');
  });

  it('accepts the supported values', () => {
    expect(parseInterval('hour')).toBe('hour');
    expect(parseInterval('minute')).toBe('minute');
    for (const g of ['event', 'channel', 'release', 'environment'] as const) {
      expect(parseGroupBy(g)).toBe(g);
    }
  });

  it('never lets a caller choose an arbitrary column to group by', () => {
    // parseGroupBy maps to a fixed slot table, so an attacker-controlled string can
    // only ever become one of four known blob columns.
    expect(parseGroupBy('blob7')).toBe('event');
    // `in` would pass both of these through to Object.prototype and build a column
    // name out of an object or a function.
    expect(parseGroupBy('__proto__')).toBe('event');
    expect(parseGroupBy('toString')).toBe('event');
    expect(parseGroupBy('constructor')).toBe('event');
  });
});

describe('seriesSql', () => {
  it('buckets by the requested interval', () => {
    expect(seriesSql(query, 'day')).toContain('toStartOfDay(timestamp) AS bucket');
    expect(seriesSql(query, 'hour')).toContain('toStartOfHour(timestamp) AS bucket');
    expect(seriesSql(query, 'minute')).toContain('toStartOfMinute(timestamp) AS bucket');
  });

  it('always weights by the sample interval', () => {
    // The whole point: unweighted aggregates read low exactly when traffic is high.
    const sql = seriesSql(query, 'day');
    expect(sql).toContain('sum(_sample_interval) AS events');
    expect(sql).toContain('sum(_sample_interval * double1) AS value');
  });

  it('scopes to the app and the time window', () => {
    const sql = seriesSql(query, 'day');
    expect(sql).toContain("index1 = 'gate-manager'");
    expect(sql).toContain('timestamp >= toDateTime(1790000000)');
  });

  it('reads from the usage dataset, not the error one', () => {
    expect(seriesSql(query, 'day')).toContain('FROM telemetry_usage');
  });

  it('adds optional filters only when given', () => {
    expect(seriesSql(query, 'day')).not.toContain('blob2 =');
    const filtered = seriesSql({ ...query, event: 'gate.opened', channel: 'prod', release: '2.0.0' }, 'day');
    expect(filtered).toContain("blob2 = 'gate.opened'");
    expect(filtered).toContain("blob1 = 'prod'");
    expect(filtered).toContain("blob3 = '2.0.0'");
  });

  it('escapes a hostile event name rather than interpolating it', () => {
    const sql = seriesSql({ ...query, event: "x' OR 1=1 --" }, 'day');
    expect(sql).toContain("blob2 = 'x\\' OR 1=1 --'");
    expect(sql).not.toContain("blob2 = 'x' OR");
  });

  it('cannot be fed a hostile app id', () => {
    const sql = seriesSql({ ...query, appId: "'; DROP TABLE telemetry_usage; --" }, 'day');
    expect(sql).toContain("index1 = '\\'; DROP TABLE telemetry_usage; --'");
  });

  it('coerces a fractional timestamp to an integer', () => {
    expect(seriesSql({ ...query, since: 1_790_000_000.9 }, 'day')).toContain('toDateTime(1790000000)');
  });
});

describe('breakdownSql', () => {
  it('groups by the chosen fixed slot', () => {
    expect(breakdownSql(query, 'event')).toContain('SELECT blob2 AS key');
    expect(breakdownSql(query, 'channel')).toContain('SELECT blob1 AS key');
    expect(breakdownSql(query, 'release')).toContain('SELECT blob3 AS key');
    expect(breakdownSql(query, 'environment')).toContain('SELECT blob4 AS key');
  });

  it('orders by volume', () => {
    expect(breakdownSql(query, 'event')).toContain('ORDER BY events DESC');
  });

  it('clamps the limit to a sane range', () => {
    expect(breakdownSql(query, 'event', 1_000_000)).toContain('LIMIT 500');
    expect(breakdownSql(query, 'event', -5)).toContain('LIMIT 1');
    expect(breakdownSql(query, 'event', 12.7)).toContain('LIMIT 12');
  });
});

describe('dailyRollupSql', () => {
  it('bounds the day at both ends so adjacent days cannot double-count', () => {
    const sql = dailyRollupSql('telemetry_usage', 'gate-manager', 1_790_000_000, 1_790_086_400);
    expect(sql).toContain('timestamp >= toDateTime(1790000000)');
    expect(sql).toContain('timestamp < toDateTime(1790086400)');
  });

  it('weights its totals too', () => {
    const sql = dailyRollupSql('telemetry_usage', 'a', 0, 1);
    expect(sql).toContain('sum(_sample_interval) AS events');
    expect(sql).toContain('sum(_sample_interval * double1) AS value');
  });
});

describe('dataset name', () => {
  it('is validated as an identifier, since it lands unquoted in the FROM', () => {
    expect(() => seriesSql({ ...query, dataset: 'usage; DROP TABLE x' }, 'day')).toThrow('refusing to use');
  });
});
