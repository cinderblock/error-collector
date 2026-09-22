#!/usr/bin/env node
/**
 * `telemetry-collector` — the command line for CI and coding agents.
 *
 * Two jobs, and they use different credentials on purpose:
 *
 * - **Build time** (`key`): derive an app's public ingest key from the app secret.
 *   No network call, so a build can compute the key for a brand-new version
 *   offline and the backend will accept it without anything ever being registered.
 * - **Triage time** (`digest`, `issues`, `issue`): pull the dataset with a scoped
 *   read token.
 *
 * Never put the app secret where the read token goes, or the reverse. The secret
 * mints ingest keys for every version of the app; the read token is disposable.
 */

import {
  deriveIngestKey,
  isValidAppId,
  isValidChannel,
  signReport,
  type ReportPayload,
} from '@cinderblock/telemetry-collector-core';

interface Flags {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      flags[name!] = inline;
    } else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) {
      flags[name!] = rest[++i]!;
    } else {
      flags[name!] = true;
    }
  }

  return { command, positional, flags };
}

function str(flags: Flags, name: string, envVar?: string): string | undefined {
  const value = flags[name];
  if (typeof value === 'string') return value;
  return envVar ? process.env[envVar] : undefined;
}

function fail(message: string): never {
  console.error(`telemetry-collector: ${message}`);
  process.exit(1);
}

/** No default: this is self-hosted software, so only you know where your copy lives. */
function endpoint(flags: Flags): string {
  const url = str(flags, 'url', 'TELEMETRY_COLLECTOR_URL');
  if (!url) fail('set TELEMETRY_COLLECTOR_URL (or pass --url) to your deployment, e.g. https://errors.example.com');
  return url.replace(/\/+$/, '');
}

async function api(flags: Flags, path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  const token = str(flags, 'token', 'TELEMETRY_COLLECTOR_TOKEN');
  if (!token) fail('a read token is required (--token or TELEMETRY_COLLECTOR_TOKEN)');

  const url = new URL(`${endpoint(flags)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    fail(`${response.status} ${response.statusText} from ${url.pathname}`);
  }
  return response.json();
}

const HELP = `telemetry-collector — report errors and pull triage data

  key       --app <id> --channel <ch>     derive the public ingest key (offline)
  digest    --app <id> [--since 7d]       everything an agent needs, one call
  issues    --app <id> [--status open]    list issues
  issue     <issue-id>                    one issue with its event samples
  apps                                    apps this token can see
  usage     --app <id> [--since 7d]       usage analytics (sampled estimates)
  channels  [--app <id>]                  versions/environments and whether each is live
  report    --key <ingestKey> --message   send a report (e.g. from a CI failure)
  track     --key <ingestKey> <event>     record a usage event

Credentials, by environment variable:
  TELEMETRY_COLLECTOR_URL           base URL of your deployment (required)
  TELEMETRY_COLLECTOR_APP_SECRET    ecs_… — build/CI only, derives ingest keys
  TELEMETRY_COLLECTOR_TOKEN         ert_… — read token for the triage commands

Common flags: --json (raw output), --url, --token, --limit, --since, --channel,
--release, --kind, --status, --q
`;

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const asJson = flags.json === true;

  switch (command) {
    case 'key': {
      const secret = str(flags, 'secret', 'TELEMETRY_COLLECTOR_APP_SECRET');
      if (!secret) fail('an app secret is required (--secret or TELEMETRY_COLLECTOR_APP_SECRET)');

      const app = str(flags, 'app') ?? positional[0];
      const channel = str(flags, 'channel') ?? positional[1];
      if (!app || !isValidAppId(app)) fail('--app must be a lowercase id with no dots');
      if (!channel || !isValidChannel(channel)) fail('--channel is required (a version, git sha, or environment)');

      // Printed bare so a build can do: KEY=$(telemetry-collector key --app x --channel $VERSION)
      console.log(await deriveIngestKey(secret, app, channel));
      return;
    }

    case 'digest': {
      const data = await api(flags, '/api/digest', {
        app: str(flags, 'app'),
        since: str(flags, 'since'),
        status: str(flags, 'status'),
        kind: str(flags, 'kind'),
        channel: str(flags, 'channel'),
        release: str(flags, 'release'),
        limit: str(flags, 'limit'),
        samples: str(flags, 'samples'),
      });
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        printDigest(data as DigestResponse);
      }
      return;
    }

    case 'issues': {
      const data = (await api(flags, '/api/issues', {
        app: str(flags, 'app'),
        status: str(flags, 'status'),
        kind: str(flags, 'kind'),
        since: str(flags, 'since'),
        channel: str(flags, 'channel'),
        q: str(flags, 'q'),
        limit: str(flags, 'limit'),
      })) as { issues: IssueSummary[] };

      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      for (const issue of data.issues) printIssueLine(issue);
      return;
    }

    case 'issue': {
      const id = positional[0];
      if (!id) fail('usage: telemetry-collector issue <issue-id>');
      console.log(JSON.stringify(await api(flags, `/api/issues/${id}`, { limit: str(flags, 'limit') }), null, 2));
      return;
    }

    case 'apps': {
      const data = (await api(flags, '/api/apps')) as { apps: { id: string; name: string }[] };
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      for (const app of data.apps) console.log(`${app.id}\t${app.name}`);
      return;
    }

    case 'usage': {
      const data = (await api(flags, '/api/usage', {
        app: str(flags, 'app'),
        since: str(flags, 'since'),
        interval: str(flags, 'interval'),
        groupBy: str(flags, 'groupBy') ?? str(flags, 'group-by'),
        event: str(flags, 'event'),
        channel: str(flags, 'channel'),
        release: str(flags, 'release'),
        limit: str(flags, 'limit'),
      })) as UsageResponse;

      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        printUsage(data);
      }
      return;
    }

    case 'channels': {
      const data = (await api(flags, '/api/channels', { app: str(flags, 'app') })) as {
        channels: ChannelRow[];
      };
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printChannels(data.channels);
      return;
    }

    case 'report': {
      await report(flags, positional);
      return;
    }

    case 'track': {
      await track(flags, positional);
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      fail(`unknown command ${JSON.stringify(command)} — try \`telemetry-collector help\``);
  }
}

async function report(flags: Flags, positional: string[]): Promise<void> {
  const key = str(flags, 'key', 'TELEMETRY_COLLECTOR_INGEST_KEY');
  if (!key) fail('--key (or TELEMETRY_COLLECTOR_INGEST_KEY) is required');

  const message = str(flags, 'message') ?? positional.join(' ');
  if (!message) fail('--message is required');

  const payload: ReportPayload = {
    kind: (str(flags, 'kind') as ReportPayload['kind']) ?? 'message',
    level: (str(flags, 'level') as ReportPayload['level']) ?? 'error',
    message,
  };
  const release = str(flags, 'release');
  const environment = str(flags, 'environment');
  if (release) payload.release = release;
  if (environment) payload.environment = environment;

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // CI holds the app secret anyway (it derives ingest keys with it), so signing
  // here is free and marks the report as provably ours.
  const secret = str(flags, 'secret', 'TELEMETRY_COLLECTOR_APP_SECRET');
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    headers['x-report-signature'] = await signReport(secret, timestamp, body);
    headers['x-report-timestamp'] = String(timestamp);
  }

  const response = await fetch(`${endpoint(flags)}/i/${key}`, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) fail(`${response.status}: ${text}`);
  console.log(text);
}

async function track(flags: Flags, positional: string[]): Promise<void> {
  const key = str(flags, 'key', 'TELEMETRY_COLLECTOR_INGEST_KEY');
  if (!key) fail('--key (or TELEMETRY_COLLECTOR_INGEST_KEY) is required');

  const event = str(flags, 'event') ?? positional[0];
  if (!event) fail('usage: telemetry-collector track --key <ingestKey> <event.name>');

  const dims: Record<string, string> = {};
  for (const [name, value] of Object.entries(flags)) {
    // Anything after `--dim.` becomes a dimension: --dim.method=cli
    if (name.startsWith('dim.') && typeof value === 'string') dims[name.slice(4)] = value;
  }

  const body = JSON.stringify({
    events: [{ event, value: Number(str(flags, 'value') ?? '1'), dims }],
    release: str(flags, 'release'),
    environment: str(flags, 'environment'),
  });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = str(flags, 'secret', 'TELEMETRY_COLLECTOR_APP_SECRET');
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    headers['x-report-signature'] = await signReport(secret, timestamp, body);
    headers['x-report-timestamp'] = String(timestamp);
  }

  const response = await fetch(`${endpoint(flags)}/u/${key}`, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) fail(`${response.status}: ${text}`);
  console.log(text);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface ChannelRow {
  app_id: string;
  channel: string;
  status: string;
  last_seen: number;
  retired_at: number | null;
  purge_after: number | null;
  note: string | null;
  issues: number;
  events: number;
}

function printChannels(channels: ChannelRow[]): void {
  if (channels.length === 0) {
    console.log('No channels yet — nothing has reported.');
    return;
  }

  const width = Math.max(...channels.map(c => c.channel.length));
  for (const channel of channels) {
    const state = channel.status === 'retired' ? 'RETIRED' : 'live';
    const purge = channel.purge_after
      ? `  purge ${new Date(channel.purge_after * 1000).toISOString().slice(0, 10)}`
      : '';
    console.log(
      `  ${channel.channel.padEnd(width)}  ${state.padEnd(7)}  ${channel.app_id.padEnd(16)}` +
        `  ${ago(channel.last_seen).padStart(4)} ago  ${String(channel.issues).padStart(5)} issues${purge}` +
        (channel.note ? `  — ${channel.note}` : ''),
    );
  }
  // Retiring is deliberately not a CLI action: it is a judgement call about whether
  // anyone is still running that version, and belongs with a human in the admin UI.
  console.log('\nRetire or resume a channel from the admin UI.');
}

interface UsageResponse {
  app: string;
  interval: string;
  group_by: string;
  series: { bucket: string; events: number; value: number }[];
  breakdown: { key: string; events: number; value: number }[];
}

function printUsage(data: UsageResponse): void {
  const total = data.series.reduce((sum, row) => sum + Number(row.events), 0);
  console.log(`# ${data.app} — ${Math.round(total).toLocaleString()} events (estimated)
`);

  if (data.breakdown.length > 0) {
    const width = Math.max(...data.breakdown.map(row => (row.key || '(none)').length));
    const peak = Math.max(...data.breakdown.map(row => Number(row.events)), 1);

    console.log(`by ${data.group_by}:`);
    for (const row of data.breakdown) {
      const events = Number(row.events);
      // A proportional bar reads faster than the numbers alone, and costs nothing.
      const bar = '#'.repeat(Math.max(1, Math.round((events / peak) * 28)));
      console.log(`  ${(row.key || '(none)').padEnd(width)}  ${String(Math.round(events)).padStart(9)}  ${bar}`);
    }
    console.log();
  }

  if (data.series.length > 0) {
    console.log(`per ${data.interval}:`);
    for (const row of data.series) {
      console.log(`  ${row.bucket}  ${String(Math.round(Number(row.events))).padStart(9)}`);
    }
    console.log();
  }

  // Said every time rather than buried in docs: these are sampled estimates, and
  // someone will eventually try to reconcile them against an exact number.
  console.log('Totals are weighted estimates from Analytics Engine sampling, not exact counts.');
}

interface IssueSummary {
  id: string;
  app_id: string;
  kind: string;
  level: string;
  title: string;
  culprit: string | null;
  status: string;
  count: number;
  attested_count: number;
  first_seen: number;
  last_seen: number;
  first_release: string | null;
  last_release: string | null;
}

interface DigestResponse {
  app: string | null;
  channels: { channel: string; last_seen: number }[];
  issues: (IssueSummary & { events: { event: Record<string, unknown> }[] })[];
}

function ago(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return `${delta}s`;
  if (delta < 3_600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h`;
  return `${Math.floor(delta / 86_400)}d`;
}

function printIssueLine(issue: IssueSummary): void {
  const releases =
    issue.first_release && issue.first_release !== issue.last_release
      ? `${issue.first_release}→${issue.last_release}`
      : (issue.last_release ?? '-');
  console.log(
    [
      issue.id.slice(0, 8),
      String(issue.count).padStart(6),
      issue.level.padEnd(7),
      releases.padEnd(14),
      `${ago(issue.last_seen)} ago`.padEnd(9),
      issue.title.slice(0, 70),
    ].join('  '),
  );
}

/** Written to be read by a human *and* pasted into a model's context. */
function printDigest(digest: DigestResponse): void {
  console.log(`# ${digest.app ?? 'all apps'} — ${digest.issues.length} issue(s)\n`);

  if (digest.channels.length > 0) {
    console.log(`channels: ${digest.channels.map(c => c.channel).join(', ')}\n`);
  }

  for (const issue of digest.issues) {
    console.log(`## ${issue.title}`);
    console.log(
      `   ${issue.id}  ${issue.kind}/${issue.level}  seen ${issue.count}x  ` +
        `first ${ago(issue.first_seen)} ago, last ${ago(issue.last_seen)} ago` +
        (issue.attested_count > 0 ? `  (${issue.attested_count} signed)` : ''),
    );
    if (issue.culprit) console.log(`   at ${issue.culprit}`);
    if (issue.last_release) console.log(`   releases ${issue.first_release ?? '?'} → ${issue.last_release}`);

    const sample = issue.events[0]?.event as
      { exception?: { values: { type?: string; value?: string; stacktrace?: { frames: StackLine[] } }[] } } | undefined;
    const thrown = sample?.exception?.values?.at(-1);
    if (thrown?.stacktrace?.frames) {
      // Innermost last, so reverse for display — humans read stacks top-down.
      for (const frame of thrown.stacktrace.frames.slice(-6).reverse()) {
        console.log(`     at ${frame.function ?? '?'} (${frame.filename ?? '?'}:${frame.lineno ?? '?'})`);
      }
    }
    console.log();
  }
}

interface StackLine {
  function?: string;
  filename?: string;
  lineno?: number;
}

main().catch((error: unknown) => {
  console.error(`telemetry-collector: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
