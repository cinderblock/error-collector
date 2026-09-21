# telemetry-collector — design

A cheap, self-hosted place to collect errors, user feedback and screenshots from
the apps I'm developing, running entirely on Cloudflare.

**No hostname appears anywhere in this repo.** Where a given copy is deployed is a
property of that deployment, not of the source — so the SDK and CLI require an
explicit endpoint, CI reads a `DEPLOY_URL` variable, and the WebAuthn relying party
is derived from the request URL. My own deployment's hostname and Cloudflare
resources are recorded in the ops repo (`plans/telemetry-collector-cloudflare.md`).

Status: **built and verified locally; not yet deployed.** Every piece below exists
and has been exercised against a local D1/R2/KV. The remaining work is the ops change
that creates the Cloudflare resources and the custom domain — which needs its own
authorization — plus the phase-2 Sentry dialect.

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

## Usage tracking (proposed, not built)

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

### Open question

If it does usage as well as errors, "telemetry-collector" undersells it — and the repo,
the package names and the hostname are all cheap to change now and annoying later.
Worth settling before this is built.

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
- [ ] **Next:** apply the ops change — creates the D1 database and KV namespace —
      then create the R2 bucket by hand (the sync system does not manage R2, and
      wrangler will not create one). Needs explicit per-change authorization.
- [ ] Set repo secrets/variables: `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`,
      `KV_NAMESPACE_ID`, `CLOUDFLARE_ACCOUNT_ID`; worker secrets `SECRET_KEK`,
      `AUTH_SECRET`, `BOOTSTRAP_TOKEN`.
- [ ] First deploy, then enrol the first passkey with the bootstrap token.
- [ ] Claim the npm scope and publish `0.0.0` placeholders, then release from CI.
- [ ] Phase 2: Sentry envelope dialect.
- [ ] Wire the first real project (candidate: Gate Manager) end to end.
