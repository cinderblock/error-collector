#!/usr/bin/env node
/**
 * `error-collector` — the command line for CI and coding agents.
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
} from '@cinderblock/error-collector-core';

const DEFAULT_URL = 'https://error-collector.tomsawyerlabs.com';

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
  console.error(`error-collector: ${message}`);
  process.exit(1);
}

function endpoint(flags: Flags): string {
  return (str(flags, 'url', 'ERROR_COLLECTOR_URL') ?? DEFAULT_URL).replace(/\/+$/, '');
}

async function api(flags: Flags, path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  const token = str(flags, 'token', 'ERROR_COLLECTOR_TOKEN');
  if (!token) fail('a read token is required (--token or ERROR_COLLECTOR_TOKEN)');

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

const HELP = `error-collector — report errors and pull triage data

  key       --app <id> --channel <ch>     derive the public ingest key (offline)
  digest    --app <id> [--since 7d]       everything an agent needs, one call
  issues    --app <id> [--status open]    list issues
  issue     <issue-id>                    one issue with its event samples
  apps                                    apps this token can see
  report    --key <ingestKey> --message   send a report (e.g. from a CI failure)

Credentials, by environment variable:
  ERROR_COLLECTOR_URL           backend base URL (default ${DEFAULT_URL})
  ERROR_COLLECTOR_APP_SECRET    ecs_… — build/CI only, derives ingest keys
  ERROR_COLLECTOR_TOKEN         ert_… — read token for the triage commands

Common flags: --json (raw output), --url, --token, --limit, --since, --channel,
--release, --kind, --status, --q
`;

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const asJson = flags.json === true;

  switch (command) {
    case 'key': {
      const secret = str(flags, 'secret', 'ERROR_COLLECTOR_APP_SECRET');
      if (!secret) fail('an app secret is required (--secret or ERROR_COLLECTOR_APP_SECRET)');

      const app = str(flags, 'app') ?? positional[0];
      const channel = str(flags, 'channel') ?? positional[1];
      if (!app || !isValidAppId(app)) fail('--app must be a lowercase id with no dots');
      if (!channel || !isValidChannel(channel)) fail('--channel is required (a version, git sha, or environment)');

      // Printed bare so a build can do: KEY=$(error-collector key --app x --channel $VERSION)
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
      if (!id) fail('usage: error-collector issue <issue-id>');
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

    case 'report': {
      await report(flags, positional);
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      fail(`unknown command ${JSON.stringify(command)} — try \`error-collector help\``);
  }
}

async function report(flags: Flags, positional: string[]): Promise<void> {
  const key = str(flags, 'key', 'ERROR_COLLECTOR_INGEST_KEY');
  if (!key) fail('--key (or ERROR_COLLECTOR_INGEST_KEY) is required');

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
  const secret = str(flags, 'secret', 'ERROR_COLLECTOR_APP_SECRET');
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

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

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
  console.error(`error-collector: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
