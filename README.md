# error-collector

A cheap place to collect errors, user feedback and screenshots from the apps I'm
developing. Runs entirely on Cloudflare — Workers, D1, R2, Analytics Engine, KV — and
is built to fit inside the free tier, degrading by shedding detail rather than by
producing a bill.

Design notes and the reasoning behind the architecture:
[`plans/error-collector-design.md`](plans/error-collector-design.md).

## What it does

- **Public ingest.** Every app gets a world-open reporting URL. Anyone running the app
  can report a crash or file feedback; no account, no login.
- **Coalescing.** Ten thousand copies of one crash become one issue with a count, not
  ten thousand rows.
- **Screenshots and attachments** in R2, automatic or user-provided.
- **A dataset API for coding agents**, behind a scoped read token.
- **Admin views** behind a passkey.

## The credential model

Three kinds of key material, deliberately independent of one another.

|                | Looks like                  | Lives in                        | Can                                 |
| -------------- | --------------------------- | ------------------------------- | ----------------------------------- |
| **App secret** | `ecs_…`                     | your password store, CI secrets | derive ingest keys, sign reports    |
| **Ingest key** | `ek1.<app>.<channel>.<mac>` | **shipped inside the app**      | write reports for one app + channel |
| **Read token** | `ert_…`                     | agent and CI environments       | read the dataset for scoped apps    |

The ingest key is **public on purpose** — it ships in client bundles, so it identifies
and routes, it does not authenticate. This is the same model Sentry uses for DSN public
keys. Abuse control lives elsewhere: rate limits, per-app quotas, size caps, and the
budget governor.

What the key's MAC actually buys is **offline derivability**:

```sh
# At build time. No network call, nothing registered anywhere.
KEY=$(error-collector key --app gate-manager --channel "$VERSION")
```

The backend recomputes that MAC from the app's secret and accepts the report, creating
the channel row on first sight. So a new version, a new PR preview, a new environment
provisions itself — and a stranger holding a real key for `1.4.2` still cannot mint one
for `9.9.9`, which is what keeps that safe.

**Read tokens are not derived from the app secret**, and that is the point. An ingest
key is compiled into binaries already in users' hands and is effectively unrotatable; a
read token sits in agent and CI environments, which is where credentials actually leak
from. Deriving both from one secret would mean revoking a leaked agent token forces
re-keying every deployed client.

### Attestation

Anything that can legitimately hold the app secret — a server, a CLI, a CI job — can
sign its reports:

```
X-Report-Timestamp: 1790000000
X-Report-Signature: v1=<hex HMAC-SHA256(secret, "…v1\n<timestamp>\n<body>")>
```

Signed reports are stored `attested`. Triage can then filter to what provably came from
your own code, which is what makes a world-open endpoint comfortable to live with. A
bad signature is rejected outright rather than downgraded to unsigned — a broken
signing setup should be loud.

## Reporting

### Browser

```ts
import { init } from '@cinderblock/error-collector';
import { installBrowserHandlers, captureScreenshot } from '@cinderblock/error-collector/browser';

const client = init({
  ingestKey: 'ek1.gate-manager.1.4.2.cc5g1c36bb3je8d7vmatrb59fm', // safe to commit
  release: '1.4.2',
  environment: 'prod',
});

installBrowserHandlers(client); // window.onerror, unhandledrejection, breadcrumbs

// User feedback, with an optional screenshot
await client.sendFeedback({
  message: 'The open button does nothing on my phone',
  screenshot: (await captureScreenshot({ mode: 'dom' })) ?? undefined,
});
```

No screenshot library is bundled — they run to hundreds of kilobytes and most apps
never use one. `captureScreenshot` takes a `renderer`, falls back to a global
`html2canvas` if the page already loaded one, and offers `mode: 'display'`
(`getDisplayMedia`) when you want the real pixels and can ask for a user gesture.

### Node / server-side

```ts
import { init } from '@cinderblock/error-collector';
import { installNodeHandlers } from '@cinderblock/error-collector/node';

const client = init({
  ingestKey: process.env.ERROR_COLLECTOR_INGEST_KEY!,
  appSecret: process.env.ERROR_COLLECTOR_APP_SECRET, // server only — enables attestation
  release: process.env.GIT_SHA,
});

installNodeHandlers(client);
```

> Never set `appSecret` in anything that runs in a browser. It mints every ingest key
> the app will ever have.

### Anything else

```sh
curl -X POST "$URL/i/$INGEST_KEY" \
  -H 'content-type: application/json' \
  -d '{"level":"error","message":"the relay stopped responding","release":"1.4.2"}'
```

## Reading the data

```sh
export ERROR_COLLECTOR_TOKEN=ert_…

error-collector digest --app gate-manager --since 7d   # everything, one call
error-collector issues --app gate-manager
error-collector issue 36738a54eb4770ec49eae33ca8db7260
```

| Endpoint                                                         | Purpose                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/digest?app=&since=&samples=`                           | Open issues, each with a representative event and stack. The one an agent should call. |
| `GET /api/issues?app=&status=&kind=&channel=&release=&since=&q=` | Issue list                                                                             |
| `GET /api/issues/:id`                                            | One issue with its event samples and attachments                                       |
| `GET /api/apps`                                                  | Apps this token can see                                                                |
| `GET /api/blob/:key`                                             | An attachment                                                                          |

## How grouping works

The fingerprint is built from the exception type plus the innermost in-app frames,
with line and column numbers excluded (they shift on every unrelated edit) and the
channel and release excluded (an issue is meant to span versions, so the UI can say
"started in 1.4.2, still happening in 1.4.4"). Messages are normalized moderately —
ids, UUIDs, addresses and numbers collapse; quoted substrings are kept, because in
`Cannot read property 'foo' of undefined` the `'foo'` usually _is_ the distinguishing
detail.

When that is wrong, send an explicit `fingerprint: ["…"]` and it wins outright.

Feedback never coalesces. Two people reporting the same annoyance are two things to
read.

## Storage, and why

| Store                | Holds                                    | Why                                                                                                                         |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **D1**               | issues, sampled events, tokens, settings | Real SQL, `ON CONFLICT` upserts — what coalescing and triage need                                                           |
| **R2**               | screenshots, attachments                 | 10 GB free and **zero egress**, which is the whole ballgame for serving images                                              |
| **Analytics Engine** | one data point per report                | Unlimited cardinality, 90-day retention, currently unbilled; survives when nothing else is being written                    |
| **KV**               | read-mostly config                       | Fast cached reads — and it is kept off every write path, because 1 000 writes/day on the free tier makes it unusable as one |

The constraint that shapes all of it: **D1's free tier hard-fails at 100 k row
writes/day** (enforced since 2026-09-01), and an error collector is exactly the
workload that spikes. So the steady state for a report whose issue already exists is
**two row writes**, batched into one round trip.

## The budget governor

Free vs. paid is a runtime setting with presets, not a build-time assumption, and every
limit is tunable. As the day's budget is consumed the service sheds detail in stages:

| Budget used | Behaviour                                                                                |
| ----------- | ---------------------------------------------------------------------------------------- |
| 0–60 %      | Everything: issues, event samples, attachments                                           |
| 60–80 %     | Attachments only from signed reports; half the samples per issue                         |
| 80–95 %     | Issue counts still update; no new samples or attachments                                 |
| 95–100 %    | Only **brand-new** issues are recorded; known ones are counted in Analytics Engine alone |
| over        | `429` + `Retry-After`                                                                    |

That 95 % rule is deliberate: the last writes of the day are worth more spent on
discovering an unknown crash than on refining the count of one you already know about.

Per-app daily quotas sit on top, so one runaway app cannot consume the account's whole
budget and blind every other app.

## Local development

```sh
bun install
bun run --cwd worker migrate:local          # apply D1 migrations to local sqlite
bun run dev                                  # wrangler dev on :8787

# in another shell — register an app and mint credentials against the local DB
bun run --cwd worker scripts/dev-seed.ts gate-manager 1.4.2 prod
bun run --cwd worker scripts/dev-token.ts agent gate-manager
```

`.dev.vars` needs `SECRET_KEK`, `AUTH_SECRET` and `BOOTSTRAP_TOKEN`; generate them with
32 random bytes each, base64url.

```sh
bun run check      # typecheck + test + format
```

## Deployment

Deploys happen in **CI only** — never `wrangler deploy` by hand, and npm packages are
published only by the release workflow, with provenance. A `prepublishOnly` guard makes
a local publish fail rather than merely discouraging it.

The custom domain `error-collector.tomsawyerlabs.com` and the D1/R2/KV/AE bindings are
declared in the [ops](https://github.com/cinderblock/ops) repo, which is the single
source of truth for Cloudflare configuration.

## Repository layout

```
packages/core/   key derivation, grouping, event normalization  (shared)
packages/sdk/    @cinderblock/error-collector — the reporter
packages/cli/    @cinderblock/error-collector-cli
worker/          the Cloudflare Worker: ingest, API, admin, cron
skills/          agent instructions for wiring this into a project
plans/           design notes
```
