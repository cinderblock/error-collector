# telemetry-collector — design

A cheap, self-hosted place to collect errors, user feedback and screenshots from
the apps I'm developing, running entirely on Cloudflare.

**No hostname, resource id or credential appears anywhere in this repo.** Where a given
copy is deployed is a property of that deployment, not of the source — so the SDK and
CLI require an explicit endpoint, the D1/KV ids arrive as build environment variables,
and the WebAuthn relying party is derived from the request URL. My own deployment's
hostname and Cloudflare resources are recorded in the ops repo
(`plans/telemetry-collector-cloudflare.md`).

This repo also holds **no Cloudflare API token and cannot deploy anything**. It is
public; a deploy job here would run `bun install` over a public dependency tree beside a
live account credential. Cloudflare Workers Builds pulls the code instead, which
reverses the credential direction. See "Deployment" in the README.

Status: **built and verified locally; the Cloudflare resources, the Worker and the
custom domain exist; the code has never been deployed.** `telemetry.tomsawyerlabs.com`
serves a 503 stub that ops provisioned. Remaining before first traffic: create the
protected `deploy` branch, let Workers Builds run, and confirm the migrations land.

## Goal

One backend that every project of mine can report into, with near-zero per-project
setup, so that:

- **Users** can file text feedback and attach (or auto-attach) a screenshot, from a
  public URL that needs no account.
- **Apps** can report uncaught exceptions automatically, coalesced so 10,000 copies
  of the same crash is one triage item, not 10,000.
- **Coding agents** working on a project can pull the error dataset for that project
  with a single scoped token, and use it as input to fixing things.
- **I** can triage from a browser/phone behind passkey login.

Cheap means: fits in Cloudflare's free tier at my volumes, and degrades by shedding
detail rather than by generating a bill or hard-failing.

## Environment / context

- Cloudflare account `c5987fbfdbb396ef3121459c26125cc0` (from
  `ops/cloudflare/workers/uptime/wrangler.toml`).
- DNS and Cloudflare account resources are managed in the **ops** repo
  (`github.com/cinderblock/ops`, local `~/git/Personal Projects/ops`). Worker custom
  domains are declared there as `- domain: <host>` + `worker: <name>` (see
  `cloudflare/config/workers/*.yaml`). The declaration for this service, and the
  hostname it uses, live in `cloudflare/config/workers/telemetry-collector.yaml` and
  `plans/telemetry-collector-cloudflare.md` over there — deliberately not here.
  **Any DNS or Cloudflare change needs per-change authorization and goes through ops.**
- ops already runs two Workers that are close precedents:
  - `cloudflare/workers/uptime` — D1 + KV + cron, server-rendered UI.
  - `cloudflare/workers/ask` — **D1 + Durable Objects + hand-rolled WebAuthn passkey
    auth + session cookies + device registration links + Web Push PWA**. Its
    `src/auth/{webauthn,tokens,guards}.ts` is ~330 lines total and is the obvious
    starting point for this project's admin auth.
- ops rule, inherited: **deploys happen in CI only**, never `wrangler deploy` by hand.
- JS/TS here means **Bun** + `bun.lock`; npm publishing (if any) via CI with
  `--provenance`.

## Decisions already locked (don't re-ask)

- Hosted on Cloudflare, behind a custom domain declared in ops. The hostname is
  deployment configuration and is never committed to this repo.
- Public, unauthenticated ingest endpoint per app — anyone holding the app can report.
- Admin UI behind passkey (WebAuthn) login, same shape as the `ask` worker.
- Separate scoped **read token** for agents/CI to pull datasets.
- Ingest credential is derived from a per-app secret so new versions need no
  registration round-trip (refined below — see "The key scheme").

Settled 2026-09-21:

- **Own repo.** `telemetry-collector` is its own git repo (default branch `master`) holding
  the worker _and_ the published SDK packages, with its own GitHub CI for deploy and
  for npm publish-with-provenance. **ops** gets only
  `cloudflare/config/workers/telemetry-collector.yaml` declaring the custom domain and the
  D1/R2/AE/KV bindings — which is an ops change needing its own authorization when the
  time comes.
- **Both Cloudflare tiers, governed at runtime.** No compile-time assumption about
  Free vs Paid. A **budget governor** holds every limit as runtime-adjustable state with
  free/paid presets, exposed as sliders in the admin UI. See "Budget governor" below.
  This is a first-class feature, not a constant.
- **Sentry envelope dialect is phase 2**, but the event model is Sentry-shaped from
  day one so it lands without a migration.
- **Single-owner, multi-user-shaped schema.** Only my passkey devices administer
  anything, but `owner_id` is carried through every table and every query is scoped by
  it from the first migration, so real accounts are later an addition rather than a
  rewrite.
- **Screenshots: both capture paths.** `html2canvas`-style DOM rendering is the default
  (works with no permission prompt); `getDisplayMedia` is opt-in for pixel-accurate
  captures. Decided without asking — reversible, and the backend is identical either way.

## Budget governor

Requirement: run correctly on Workers Free _or_ Paid, auto-adapt, and let me tune the
limits at runtime. The goal is that exceeding capacity **sheds detail**, never generates
a surprise bill and never hard-fails D1 for the rest of the account.

**Analytics Engine is the meter.** Every accepted report writes exactly one AE data
point whose doubles carry `[1, d1RowsWritten, blobBytesWritten]`. AE is unsampled at our
volumes, 90-day retained, and currently unbilled — so the cheapest thing in the stack is
also the thing that counts the expensive things. A cron tick queries AE's SQL API for
today's totals (1/min = ~1 440 of the 10 000 free daily queries), derives a level, and
writes it to KV **only when the level changes** — which keeps us far under KV's 1 000
writes/day free ceiling. The ingest path reads that key with `cacheTtl`, so the hot path
costs one cached KV read.

**Degradation ladder**, as the day's budget is consumed:

| Budget used | Behaviour                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| 0–60 %      | Full detail: issue upsert, event samples, blobs, everything.                 |
| 60–80 %     | Stop accepting new blobs from _unattested_ reports; halve samples per issue. |
| 80–95 %     | Issues only — upsert counts, write no new event rows.                        |
| 95–100 %    | AE only — the report is counted and acknowledged `202`, nothing is stored.   |
| over        | `429` + `Retry-After`, so clients back off instead of retry-storming.        |

Plan detection: default to the **free** preset (the safe one) and let the admin UI flip
to paid, with an optional "detect" that reads the account's Workers plan via the CF API
when an account token is configured. Never infer the plan from a failure.

Tunable knobs (all runtime, all with free/paid presets): daily caps for worker requests,
D1 row writes, AE data points and R2 bytes; total R2 bytes; and per-app
`maxEventsPerDay`, `maxSamplesPerIssue`, `sampleEveryN`, `maxBodyBytes`,
`maxScreenshotBytes`, `retentionDays`. Defaults self-seed on first read, mirroring the
`cost:thresholds` / `cost:state` pattern already proven in the ops `uptime` worker.

## Why greenfield rather than off-the-shelf

| Option                          | Verdict                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Sentry** (self-hosted)        | The real thing, but wants Docker + Kafka + ClickHouse and ~16 GB RAM. Not a Cloudflare workload; far past "cheap".                     |
| **GlitchTip**                   | Sentry-SDK-compatible reimplementation, Postgres + Redis + worker processes. Needs an always-on box; no CF story.                      |
| **Bugsink**                     | Lightest of the three, deliberately single-machine, Postgres-backed. Still a box, still not CF, and no user-feedback/screenshot story. |
| **Highlight.io / rrweb stacks** | Session replay; much heavier than the problem.                                                                                         |
| **Greenfield on CF**            | Nothing exists that is Cloudflare-native for this.                                                                                     |

**But** the ingest _protocol_ is worth stealing rather than inventing. See below.

### Steal the Sentry envelope protocol as one ingest dialect

Sentry's wire format is a documented, newline-delimited-JSON "envelope" POSTed to
`/api/<projectId>/envelope/`, authenticated by a **DSN public key that Sentry
explicitly documents as safe to publish** — it identifies the project, it does not
authenticate. That is precisely the design instinct behind this project, already
industry-standard and already battle-tested.

If the collector speaks that dialect, then `@sentry/browser`, `@sentry/node`,
`sentry-python`, `sentry-go`, the Rust/Java/Swift SDKs, source-map upload, release
tagging and breadcrumbs all work by changing **one DSN string** — no SDK-writing
treadmill, in any language, ever. That is a very large amount of leverage for the cost
of an envelope parser.

Plan: **two dialects on the same backend.**

1. `POST /i/<ingestKey>` — the native dialect. One flat JSON body, or
   `multipart/form-data` when there's a screenshot. Trivially `curl`-able, trivially
   implementable from a shell script, an ESP32, or a coding agent. This is the one
   the published libraries and the user-feedback widget use.
2. `POST /api/<appId>/envelope/` — Sentry-compatible. Accepts envelopes from any
   stock Sentry SDK, normalizes into the same tables. Lets an existing project with
   Sentry already wired in point at this and keep everything.

Dialect 2 is a phase-2 item, but the data model must be designed so it slots in
without migration — i.e. model the event on Sentry's event payload shape from day one.

## Storage: analysis of the Cloudflare options

The workload is not one shape, it's four, and they want different stores.

| Data class                                                     | Volume                | Access pattern                                     |
| -------------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| A. Issues (coalesced groups)                                   | Low — hundreds        | Read/updated constantly, listed, filtered, counted |
| B. Event samples (individual occurrences w/ stack + context)   | Medium — thousands    | Append; read a handful per issue                   |
| C. Raw volume / time series ("how often, which version, when") | High — can spike hard | Aggregate queries only                             |
| D. Blobs (screenshots, HARs, console dumps, source maps)       | Low count, high bytes | Write once, read rarely, serve to admin UI         |

### The options, with current (Sept 2026) numbers

| Store                                    | Free tier                                                                     | Paid ($5/mo Workers Paid)                                                            | Fit                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** (SQLite)                          | 5 GB, 5 M rows read/day, **100 K rows written/day**                           | 25 B reads + 50 M writes/mo incl.; $0.001/M read, $1.00/M written, $0.75/GB-mo       | **A + B.** Real SQL, joins, `GROUP BY`, `ON CONFLICT` upserts — exactly what coalescing and triage need.                                                                                           |
| **Durable Objects** (SQLite)             | 5 GB, 5 M rows read/day, 100 K rows written/day, 100 K req/day, 13 k GB-s/day | 1 M req + 400 k GB-s incl.; storage $0.20/GB-mo after 5 GB                           | Per-app serialization + exact counters + write batching. Same daily row ceiling as D1, so it is **not** an escape hatch from volume — it's an escape hatch from _contention_. Add later if needed. |
| **Workers KV**                           | 1 GB, 100 K reads/day, **1 000 writes/day**                                   | 10 M reads + 1 M writes/mo; $0.50/M read, $5.00/M write                              | **Read-mostly config only.** 1 000 writes/day makes KV unusable on any write path. Good for `appId → secret/settings` cache.                                                                       |
| **Analytics Engine**                     | **100 K data points/day**, 10 K queries/day                                   | 10 M points + 1 M queries/mo; $0.25/M, $1.00/M — **and currently not billed at all** | **C.** Unlimited cardinality, 90-day retention, SQL API. Write one data point per report _always_, even when the D1 row is dropped, so true volume survives.                                       |
| **R2**                                   | **10 GB, 1 M Class A, 10 M Class B, zero egress**                             | $0.015/GB-mo, $4.50/M A, $0.36/M B                                                   | **D.** Screenshots and oversized payloads. Zero egress is the whole ballgame for serving images to the admin UI.                                                                                   |
| **Queues**                               | Free since Feb 2026 but only **10 K ops/day**, 24 h retention                 | 1 M ops/mo incl., $0.40/M                                                            | Buffering ingest → batch writes. On free tier its 10 K/day ceiling is _tighter_ than D1's 100 K writes/day, so it buys nothing yet. Revisit on paid.                                               |
| **Pipelines + R2 Data Catalog + R2 SQL** | free ingress; R2 SQL $2.50/TB scanned (1 GB/mo free)                          | transforms $0.04/GB, sink $0.03/GB                                                   | Iceberg-on-R2 for genuinely large event archives. Correct answer at millions of events/day. **Overkill here** — noted as the scale-out path, not the starting point.                               |
| **Hyperdrive / external Postgres**       | —                                                                             | —                                                                                    | Defeats the "cheap, all-CF" goal. Rejected.                                                                                                                                                        |

### Two limits that actually shape the design

1. **D1's free tier now hard-fails.** Since 2026-09-01, exceeding the free daily row
   limits returns errors rather than throttling. An error collector is _exactly_ the
   workload that spikes — one bad deploy of one app can emit a crash per page load.
   The design must therefore not write a row per report.
2. **Workers Free is 100 K requests/day, account-wide** — shared with the uptime
   worker's per-minute cron and everything else on the account. That, not storage, is
   the first wall an ingest endpoint hits.

### Recommended architecture

**D1 (primary) + R2 (blobs) + Analytics Engine (volume) + KV (read-only config cache).**

The load-bearing idea is **coalesce at the edge, before touching D1**:

```
report arrives
  ├─ always: env.AE.writeDataPoint(...)            # 1 data point, never dropped
  ├─ fingerprint = hash(app, channel, type, top frames)
  ├─ D1: INSERT INTO issues ... ON CONFLICT(fingerprint)
  │        DO UPDATE SET count = count + 1, last_seen = ?   # 1 row write, flood-proof
  ├─ event row: only if this issue has < N samples, or every Mth occurrence
  └─ blobs (screenshot / big payload) → R2, key referenced from the row
```

10 000 identical crashes become ~1 issue upsert + ~10 sample rows + 10 000 AE data
points. Volume is preserved exactly where it is cheap (AE), detail is preserved where
it is useful (D1), and D1's daily write budget is spent on _distinct_ problems.

Per-app daily quotas on top, so one runaway app cannot consume the account-wide
budget and blind every other app.

## The key scheme — analysis and refinement

The proposed scheme (dev holds a secret, app ships a hash of it, hash is the write
key, secret/agent token is the read key) is **the right instinct** — it is the same
public-identifier model Sentry uses for DSNs — but it needs three corrections.

### 1. Be explicit that the ingest key is _public_, and stop expecting it to authenticate

It is shipped inside a client bundle and the endpoint is open to the world by design.
Anyone who has the app has the key. So it must be treated as an identifier, and all
abuse control must live elsewhere (rate limits, quotas, size caps, Turnstile). What
the derived key genuinely buys is:

- **Non-enumerability** — nobody can guess `/i/<app>/<version>` for apps they've never
  seen. (A random string would do this equally well.)
- **Offline derivability** — this is the real win, and the thing a random string can't
  do. A build can compute its own ingest key from the app secret with **no API call**,
  and the server can verify it with **no prior registration**, so a new version/channel
  provisions itself on first report. That is the "configurationless" property, and it
  is worth keeping.
- **Single-point revocation** — rotate the app secret, every derived key dies at once.

### 2. Use HMAC with domain separation, not a bare hash — and make the key self-describing

A bare `hash(secret || version)` is the wrong primitive (length-extension, no domain
separation, and it invites brute-forcing a weak secret). Also, the server cannot invert
a hash to learn _which_ channel it is, so the channel has to travel alongside it
anyway — at which point it may as well be inside one pasteable token:

```
appSecret  S  = 32 random bytes. Shown once at registration. Lives in my password
                store and in the project's CI secret. NEVER ships in an app.

ingestKey     = "ek1." + appId + "." + channel + "." +
                base32( HMAC-SHA256(S, "ingest.v1|" + appId + "|" + channel)[0..15] )
```

`channel` is any string the developer picks — a semver (`1.4.2`), a git SHA, an
environment (`prod`, `staging`), or a PR slug (`pr-812`). One app secret therefore
yields unlimited self-provisioning channels, all readable by the same dev token,
which is the per-version behaviour originally wanted.

The server verifies by loading `S` for `appId` (KV-cached), recomputing, and doing a
constant-time compare; on success it **auto-creates the channel row if absent**. No
registration call, ever, for a new version.

Making it human-readable rather than opaque is deliberate: someone reading the app
bundle should be able to tell at a glance that this is a public routing identifier and
not a leaked credential.

Nice side effect: this same string drops straight into a Sentry DSN's public-key slot —
`https://ek1.myapp.1.4.2.7f3k…@errors.example.com/myapp` — so one
token serves both ingest dialects.

### 3. Do **not** derive the read token from the same secret

The two credentials have opposite requirements:

- The **ingest key is baked into shipped binaries** — it must be stable and is
  effectively unrotatable in any reasonable timeframe.
- The **read token lives in agent and CI environments** — the places credentials
  actually leak from — so it must be cheap to revoke and re-issue.

Deriving both from `S` couples them: revoking a leaked agent token would force
re-keying every deployed app instance. So:

```
readToken = "ert_" + base32(32 random bytes)
```

stored **hashed (SHA-256) in D1**, scoped to one or more apps, read-only, with an
expiry and a `last_used_at`. Independent lifecycle, independent revocation.

### 4. Worth adding: optional attestation for reports that _can_ hold a secret

Server-side apps, CLIs, CI jobs and dev machines can legitimately hold `S`. Let those
sign the report body:

```
X-Report-Signature: v1=<hex HMAC-SHA256(S, canonical_body)>
```

and mark the stored event `attested = 1`. Browser/public reports stay `attested = 0`.
Triage can then filter to attested-only, which makes an open public endpoint
comfortable to live with. Cheap to implement, large practical payoff.

## Data model (sketch — to firm up after the open questions)

- `apps` — id, name, secret (encrypted), created, settings (quotas, retention).
- `channels` — app_id, channel, first_seen, last_seen, auto-created on first valid key.
- `issues` — id, app_id, fingerprint (unique), title, culprit, level, kind
  (`error` | `feedback`), status (`open`/`resolved`/`ignored`), count, first_seen,
  last_seen, first_channel, last_channel.
- `events` — id, issue_id, app_id, channel, ts, attested, payload (JSON, Sentry-event
  shaped), blob keys.
- `blobs` — r2 key, event_id, kind (`screenshot`/`har`/`console`/`attachment`), bytes,
  content_type.
- `read_tokens` — hash, name, scope (app ids), expires_at, last_used_at.
- `devices` / `sessions` — passkey credentials, cribbed from the `ask` worker.
- Analytics Engine dataset `telemetry_events` — indexed by app, blobs: channel, fingerprint,
  level, kind; doubles: 1.

## Usage tracking (built 2026-09-21)

Asked 2026-09-21: can this collect product usage too? **Yes — and Analytics Engine,
already wired in, is precisely a usage-analytics store.** But one thing is
non-negotiable:

> **Usage events must never touch D1.**

The error path costs ~2 D1 row writes per report, which is right for errors (rare,
and you want the detail) and catastrophic for usage. A pageview is not an "issue";
you do not want a row per pageview; and 100 k D1 writes/day would be gone in an
afternoon. Worse, usage would pollute the very `usage_daily` counters the governor
grades against, so tracking usage would throttle error collection.

So: a separate path writing **one AE data point and nothing else**.

```
POST /u/<ingestKey>     { event: "gate.opened", value?: 1, dims?: {...} }
  └─ rate limit → env.AE.writeDataPoint(...)      # zero D1 writes
```

It reuses the same app, ingest key, channel, release and attestation, so a project
gets three kinds of signal from one integration.

### What it costs

|              | Free                                                | Paid                  |
| ------------ | --------------------------------------------------- | --------------------- |
| Data points  | 100 k/day (and AE is _currently not billed at all_) | 10 M/mo, then $0.25/M |
| Read queries | 10 k/day                                            | 1 M/mo, then $1.00/M  |

Cheaper per event than the error path by a wide margin.

### What it needs that does not exist yet

1. The `/u/` endpoint plus a `track()` in the SDK — small.
2. **A read path through the AE SQL API.** This is the real work: AE is written via a
   binding but _queried_ over HTTPS with an account token (`CF_ANALYTICS_TOKEN`,
   already anticipated in `wrangler.toml`). New: query builder, `/api/usage`, a
   usage tab in the admin UI.
3. **A daily rollup into D1.** AE retention is 90 days with no knob. One tiny row per
   (app, event, day) preserves history indefinitely for a rounding error of storage,
   and must exist _before_ the first data ages out to be worth anything.

### Caveats worth knowing before saying yes

- **AE samples under load.** Above roughly 100 data points/sec per index value it
  samples, and every row carries `_sample_interval` that queries must multiply by.
  Counts come out statistically accurate, not exact. Fine for "how much is this
  used"; wrong for anything you would bill on.
- **Aggregate-only.** You cannot retrieve an individual usage event. If exact
  per-event records are ever needed that is Pipelines → R2 Iceberg, the documented
  scale-out path.
- **Uniques are awkward.** AE has no HyperLogLog, and `count(distinct)` over a
  sampled dataset is unreliable. Combined with the existing no-IP stance, the honest
  answer is to report event counts and not pretend to count people.
- **A world-open usage endpoint can have its counts inflated** by anyone who reads
  the key out of your bundle. For errors that is tolerable — you triage them and
  notice. Inflated usage numbers are _silently_ wrong. Attestation covers server-side
  events; nothing covers browser events. Acceptable for "roughly how much do my own
  apps get used", not for a decision with money attached.

### As built

Matches the design above, with these decisions made during implementation:

- **Separate AE dataset** (`telemetry_usage`), not a discriminator column in the error
  dataset. AE has no column names — only `blob1..blob20` — so two record shapes in one
  dataset means every query has to remember to exclude the other, and the failure mode
  when one forgets is silently blended numbers rather than an error.
- **The positional field layout lives in one module** (`core/src/usage.ts`) used by
  both the writer and the query builder, for the same reason: two matching argument
  lists in two files drift, and the symptom is mis-attributed data.
- **Usage reads the governor level from KV, not D1.** The error path reads
  `usage_daily` directly because staleness during a flood is expensive and D1 writes
  are what is being protected. Usage has no D1 writes to protect, so a D1 round trip
  per pageview would be the most expensive thing in an otherwise free path.
- **Usage is shed at `issues-only` and beyond**, well before errors are.
- **SQL escaping is the security boundary.** The AE SQL API takes raw text with no
  bind parameters, and event names arrive from query strings. All quoting goes through
  one `lit()` function, tested by round-tripping hostile inputs through a parser that
  mimics ClickHouse rather than by regex — a regex cannot tell an escaped backslash
  from an escaping one and calls correct output wrong.
- Two bugs the tests caught: `parseGroupBy` used `in`, which walks the prototype chain,
  so `__proto__` and `toString` passed the allowlist and indexed into
  `Object.prototype`; and the bar chart drew 240px slabs for short windows.

The naming question was settled first — renamed from `error-collector` before this
was built, precisely so the name would not write a cheque the code had not cashed.

## Deliverables beyond the backend

1. **`@cinderblock/telemetry-collector` (npm, published by CI with provenance)** — browser
   - Node reporter. `init({ ingestKey })`, global `onerror`/`unhandledrejection` hooks,
     breadcrumbs, `reportFeedback({ text, screenshot })`, offline queue.
2. **Feedback widget** — a drop-in that captures a screenshot client-side
   (`html2canvas` or `getDisplayMedia`) and posts it with the user's text.
3. **A `curl` recipe** — the native dialect must be usable in one line from anything.
4. **Agent skill** (`.claude/skills/telemetry-collector/`) — instructions for an agent to:
   register a new app, derive the ingest key at build time, wire the SDK into an
   existing project, and pull the dataset via the read token for triage.
5. **A build-time key derivation helper** — a tiny script/CLI so CI computes
   `ingestKey` from the CI-held app secret and injects it into the bundle.

## Open questions for the user

All four opening questions were answered on 2026-09-21 and are recorded under
"Decisions already locked". Remaining, to raise when the work reaches them:

1. **npm scope for the published SDKs** — `@cinderblock/*` or something else? Needs
   the org to exist on npm before the first publish workflow runs. (Placeholder-`0.0.0`
   name claim is the one sanctioned local publish; everything real ships from CI.)
2. **ops change** — `cloudflare/config/workers/telemetry-collector.yaml` is now staged in
   ops (dry-run verified, purely additive) but **not committed or applied**. Applying
   it needs explicit per-change authorization.
3. **Retention default** — AE keeps 90 days regardless. How long should D1 event rows
   and R2 screenshots live before the cleanup cron prunes them? Proposing 30 days for
   events/blobs, forever for issue rows (they're small and are the triage surface).

## Things not to do

- Don't put anything on a write path in **KV** — 1 000 writes/day on free tier.
- Don't write one D1 row per report; the free tier now hard-errors at 100 K writes/day.
- Don't reach for **Queues** as flood protection on the free tier — 10 K ops/day is a
  tighter ceiling than the D1 limit it would be protecting.
- Don't ship the app secret `S` to any client, and don't derive the agent read token
  from it.
- Don't touch Cloudflare DNS or account settings outside the ops repo, and not without
  per-change authorization.
- Don't `wrangler deploy` by hand — CI only.

## Findings / gotchas

Things that were not obvious going in, recorded so they are not re-derived:

- **D1's free tier hard-fails.** Since 2026-09-01 exceeding the daily row limits
  returns errors rather than throttling. This is the single constraint that shaped the
  whole write path.
- **KV allows 1 000 writes/day on free.** It cannot be on any write path. It is a
  read-through cache and nothing else.
- **Queues is free since Feb 2026 but capped at 10 000 ops/day** — a _tighter_ ceiling
  than the 100 k D1 writes it would be protecting. It buys nothing at this tier.
- **Workers isolate-level memoisation matters more than expected.** The naive design
  read governor state, the app record and the channel registry from KV on every
  report, which would have exhausted the 100 k/day KV read allowance well before the
  request allowance. `worker/src/cache.ts` removes most of those.
- **Sentry orders exception chains oldest-first**, so the _last_ entry is the error
  actually thrown and is what grouping should key on. Writing the test first got this
  backwards; the accessor is now named `primaryException` rather than
  `innermostException` so the next reader does not repeat it.
- **Frames are innermost-last** in the stored model while every engine's
  `Error.stack` is innermost-first. Getting the reversal wrong builds every
  fingerprint from `main()` and silently merges unrelated crashes — silently, which is
  why there is an explicit test for it.
- **Pruning events must recompute `issues.sample_count`.** Without it, an issue whose
  samples aged out sits permanently at its sampling cap and never keeps another
  example. The bug would first appear one retention period after launch.
- **`workspace:*` is a Bun protocol npm does not understand.** Publishing without
  rewriting it ships a package that fails to install for everyone.
- **SQLite upsert conflict targets**: two unique constraints that always fail together
  make `ON CONFLICT` behaviour depend on which one SQLite checks first. The issue id
  is derived from the fingerprint so the primary key is the only conflict target.
- The `title=` prohibition is enforced by a check across every rendered page, and the
  meter component has a test asserting it emits none.

## Progress log

- [x] 2026-09-21 — Surveyed ops repo: existing worker patterns, CI deploy flow,
      passkey implementation in `ask`, and the DNS config layout.
- [x] 2026-09-21 — Priced and compared every CF storage option against the four data
      classes; identified the D1 free-tier hard-fail and KV write ceiling as the two
      constraints that shape the design.
- [x] 2026-09-21 — Analysed the proposed hash-key scheme; refined to HMAC-derived,
      self-describing, self-provisioning ingest keys with independent read tokens.
- [x] 2026-09-21 — Design doc written; four opening questions answered.
- [x] 2026-09-21 — Repo scaffolded (bun workspaces, `master`), core package with key
      derivation, grouping and normalization. 63 tests.
- [x] 2026-09-21 — D1 schema, budget governor, native ingest dialect. Verified against
      local D1/R2: coalescing, forged-channel rejection, attestation, screenshots.
- [x] 2026-09-21 — Scoped read tokens and the agent dataset API, including `/api/digest`.
      Scope isolation verified.
- [x] 2026-09-21 — SDK and CLI packages. Verified end to end against the running worker,
      including a key derived offline for an unregistered version being accepted.
- [x] 2026-09-21 — README, agent skill, CI (check / deploy / publish).
- [x] 2026-09-21 — Passkey auth and the admin UI. All five governor levels probed
      against real usage ratios. 133 tests, clean typecheck.
- [x] 2026-09-21 — Renamed the npm scope to `@cinderblock`; pushed to
      `github.com/cinderblock/telemetry-collector` (public, default branch `master`).
- [x] 2026-09-21 — Removed every hardcoded deployment hostname: the SDK and CLI now
      require an explicit endpoint, `RP_ID`/`ORIGIN` were dead config and are gone,
      and CI smoke-tests against a `DEPLOY_URL` variable.
- [x] 2026-09-21 — Staged the ops config (`cloudflare/config/workers/telemetry-collector.yaml`
      plus `plans/telemetry-collector-cloudflare.md`). Dry-run: 2 resources to create, 0
      updates, 0 deletes. Not committed, not applied.
- [x] 2026-09-22 — Applied the ops change: `TELEMETRY_DB` (D1) and `TELEMETRY_KV` (KV)
      now exist. The apply happens in ops CI, not locally — the workstation's
      Cloudflare token is read-only on every permission, which is what makes "never
      deploy manually" a property of the credentials rather than of anyone's
      discipline. `sync-verify` reported 0/0/0 afterwards. The ids are recorded in the
      ops repo (private), not here.
- [x] 2026-09-22 — The R2 bucket exists, created by ops IaC rather than by hand: an
      `r2` provider was added to the ops Cloudflare sync so `- r2: telemetry-collector-blobs`
      is declarative like D1 and KV. Two bugs found the hard way and both now
      commented in place — the provider must not throw when R2 is unreadable (the
      registry fetches under one `Promise.all`, so it took down DNS, D1, KV and
      tunnels too), but it _must_ throw when a create fails (the orchestrator reads
      only a thrown error, so collecting instead printed "✓ Created" and went green
      with no bucket).
- [x] 2026-09-23 — ops provisions the Worker itself (`ops@3961d2b`, applied). Deciding
      this needed the granular Workers permissions: "Editor" can deploy into an
      existing worker but explicitly **cannot create or delete** one. Rather than give
      this repo Admin on the whole account just so its _first_ deploy has somewhere to
      land, ops creates an empty 503 stub and this repo keeps Editor permanently.
      `telemetry.tomsawyerlabs.com` is attached and serving the stub; ops `sync-verify`
      reports in sync. It cost ops no new permission — the sync token already creates
      workers. See `ops/plans/telemetry-collector-cloudflare.md`.
- [x] 2026-09-23 — Deploy workflow now **fails** on missing or malformed configuration
      instead of skipping green. The old `configured` gate skipped the whole job when
      `D1_DATABASE_ID` was unset, so a run that deployed nothing reported success —
      exactly the false-green this project exists to catch elsewhere. All five values
      are now checked up front (presence _and_ shape, every problem listed at once),
      the API token is verified against Cloudflare before migrations run, a binding id
      left as `"local"` is caught, and the smoke test is mandatory rather than
      conditional on `DEPLOY_URL`.
- [x] 2026-09-23 — **Deploy workflow deleted; this repo now holds no Cloudflare
      credential at all.** The previous entry was fixing the wrong layer. The real
      problem was not that the deploy job skipped green, it was that the job existed:
      this repo is **public**, and it would have run `bun install` over a public
      dependency tree in the same step as a live account token. `ops`' own
      `plans/ops-owned-app-deploys.md` names that as "the everyday risk, not the exotic
      one" — it was read during this work and wrongly filed as "containers only." No
      token was ever minted, so nothing leaked; the design was caught before the
      credential existed.
- [x] 2026-09-23 — **Cloudflare Workers Builds** connected. Cloudflare pulls the code
      through a GitHub App, so the credential direction reverses and nothing
      Cloudflare-shaped is stored here. `D1_DATABASE_ID` and `KV_NAMESPACE_ID` are
      build environment variables, so the ids stay out of this public repo too.
      Git tags turned out **not** to be a supported trigger — Workers Builds listens to
      a branch — so deploys come from a protected `deploy` branch instead.
- [x] 2026-09-23 — Migrations settled: they run in the **deploy command**, ahead of
      `wrangler deploy`. That command executes only for the production branch, so no
      `master` push and no preview build can ever migrate production. Whether
      Cloudflare's build environment carries D1 write authority is still unverified —
      the first build answers it and fails loudly if not.
- [ ] **Next:** create the `deploy` branch, protect it on GitHub requiring `ci.yml`,
      point Cloudflare's production branch at it, and ship. Workers Builds has no
      visibility into GitHub Actions, so without the protection a red-CI commit would
      build and deploy regardless — the branch rule is what makes that impossible.
- [ ] Once a real deploy has landed: publish `/build-info.json` carrying
      `WORKERS_CI_COMMIT_SHA`, add this service to the ops uptime worker's
      `deploySites`, and extend that monitor to also warn when `deploy` falls too far
      behind `master`. Layer one catches a silently broken pipeline (the
      arbitraryshit.com failure — 13 skipped pushes, 8-day-old content, 200 OK, no
      alert); layer two catches work that was never shipped.
- [ ] Worker secrets once deployed: `SECRET_KEK`, `AUTH_SECRET`, `BOOTSTRAP_TOKEN`,
      and `CF_ANALYTICS_TOKEN` if usage charts are wanted (writing usage needs no
      token; only reading does).
- [ ] First deploy, then enrol the first passkey with the bootstrap token.
- [ ] Claim the npm scope and publish `0.0.0` placeholders, then release from CI.
- [x] 2026-09-21 — Usage tracking: `/u/` ingest (AE-only, zero D1), SQL API read path,
      `/api/usage`, admin tab with validated charts, `track()` in the SDK, `usage` and
      `track` in the CLI, and the daily rollup that beats AE's 90-day retention.
      216 tests.
- [x] 2026-09-22 — Channel lifecycle and retention. Retiring a version is explicit and
      answers 410, which the SDK honours by standing down; retire-then-purge-later
      covers the graceful transition. Issues were previously never pruned at all —
      resolved/ignored now age out, open ones only if opted into. Daily maintenance is
      callable on demand rather than only at 04:17, because tying it to one minute of
      the day made it untestable. Verified end to end including that purging deletes
      the R2 _objects_, not just the rows that cascade away.
- [ ] Phase 2: Sentry envelope dialect.
- [ ] Wire the first real project (candidate: Gate Manager) end to end.
