# error-collector — design

A cheap, self-hosted place to collect errors, user feedback and screenshots from
the apps I'm developing, running entirely on Cloudflare, at
`error-collector.tomsawyerlabs.com`.

Status: **design / architecture. Nothing built yet.** Open questions at the bottom
are blocking the first line of code.

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
- DNS for `tomsawyerlabs.com` is managed in the **ops** repo
  (`github.com/cinderblock/ops`, local `~/git/Personal Projects/ops`), file
  `cloudflare/config/isozilla/tomsawyerlabs.yaml`. Worker custom domains are declared
  there as `- domain: <host>` + `worker: <name>` (see `cloudflare/config/workers/*.yaml`).
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

- Hosted on Cloudflare. Custom domain `error-collector.tomsawyerlabs.com`.
- Public, unauthenticated ingest endpoint per app — anyone holding the app can report.
- Admin UI behind passkey (WebAuthn) login, same shape as the `ask` worker.
- Separate scoped **read token** for agents/CI to pull datasets.
- Ingest credential is derived from a per-app secret so new versions need no
  registration round-trip (refined below — see "The key scheme").

Settled 2026-09-21:

- **Own repo.** `error-collector` is its own git repo (default branch `master`) holding
  the worker _and_ the published SDK packages, with its own GitHub CI for deploy and
  for npm publish-with-provenance. **ops** gets only
  `cloudflare/config/workers/error-collector.yaml` declaring the custom domain and the
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
`https://ek1.myapp.1.4.2.7f3k…@error-collector.tomsawyerlabs.com/myapp` — so one
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
- Analytics Engine dataset `error_events` — indexed by app, blobs: channel, fingerprint,
  level, kind; doubles: 1.

## Deliverables beyond the backend

1. **`@tomsawyerlabs/error-collector` (npm, published by CI with provenance)** — browser
   - Node reporter. `init({ ingestKey })`, global `onerror`/`unhandledrejection` hooks,
     breadcrumbs, `reportFeedback({ text, screenshot })`, offline queue.
2. **Feedback widget** — a drop-in that captures a screenshot client-side
   (`html2canvas` or `getDisplayMedia`) and posts it with the user's text.
3. **A `curl` recipe** — the native dialect must be usable in one line from anything.
4. **Agent skill** (`.claude/skills/error-collector/`) — instructions for an agent to:
   register a new app, derive the ingest key at build time, wire the SDK into an
   existing project, and pull the dataset via the read token for triage.
5. **A build-time key derivation helper** — a tiny script/CLI so CI computes
   `ingestKey` from the CI-held app secret and injects it into the bundle.

## Open questions for the user

All four opening questions were answered on 2026-09-21 and are recorded under
"Decisions already locked". Remaining, to raise when the work reaches them:

1. **npm scope for the published SDKs** — `@tomsawyerlabs/*` or something else? Needs
   the org to exist on npm before the first publish workflow runs. (Placeholder-`0.0.0`
   name claim is the one sanctioned local publish; everything real ships from CI.)
2. **ops change to declare the domain** — when the worker is ready to deploy, the
   `cloudflare/config/workers/error-collector.yaml` addition and the
   `error-collector.tomsawyerlabs.com` record need explicit per-change authorization.
   Nothing will be staged in ops before then.
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

## Progress log

- [x] 2026-09-21 — Surveyed ops repo: existing worker patterns, CI deploy flow,
      passkey implementation in `ask`, DNS config for `tomsawyerlabs.com`.
- [x] 2026-09-21 — Priced and compared every CF storage option against the four data
      classes; identified the D1 free-tier hard-fail and KV write ceiling as the two
      constraints that shape the design.
- [x] 2026-09-21 — Analysed the proposed hash-key scheme; refined to HMAC-derived,
      self-describing, self-provisioning ingest keys with independent read tokens.
- [x] 2026-09-21 — Design doc written.
- [ ] Answer the four open questions.
- [ ] Scaffold repo, wrangler config, D1 migrations.
- [ ] Native ingest dialect + coalescing + AE writes + R2 blobs.
- [ ] Passkey admin UI (port from `ask`).
- [ ] Read-token dataset API + agent skill.
- [ ] npm SDK + feedback widget, published from CI.
- [ ] Sentry envelope dialect.
