---
name: telemetry-collector
description: Wire a project up to the telemetry-collector backend, or pull its collected errors, user feedback and usage analytics. Use when asked to "add error reporting", "add usage tracking/analytics", "collect crashes/feedback from this app", "set up telemetry-collector", "what errors are users hitting", "check reported bugs", "triage production errors", "how much is this feature used", or when investigating a bug that users have reported from a deployed app.
---

# telemetry-collector

A self-hosted collector for crashes, user feedback and usage analytics, running on
Cloudflare. This skill covers the two things an agent does with it: **wiring a project
up to it**, and **reading the data to fix things**.

**Where is it?** There is no canonical server and no hostname baked into anything —
read `TELEMETRY_COLLECTOR_URL` from the environment. If it is not set, ask the user for
their deployment's URL rather than guessing one.

## Credentials — read this before touching anything

Three kinds, and mixing them up is the one genuinely damaging mistake available here.

|            | Looks like                  | Where it belongs                           | Never                                          |
| ---------- | --------------------------- | ------------------------------------------ | ---------------------------------------------- |
| App secret | `ecs_…`                     | CI secrets, password store                 | **never** in a client bundle, a repo, or a log |
| Ingest key | `ek1.<app>.<channel>.<mac>` | committed config, client bundles           | — it is public by design                       |
| Read token | `ert_…`                     | your own env (`TELEMETRY_COLLECTOR_TOKEN`) | not in the app                                 |

The ingest key being public is intentional, not an oversight. Do not "fix" it by moving
it into a secret, proxying it, or obfuscating it — the endpoint is meant to be
world-open, and the backend's protection is rate limits, quotas and the budget
governor, not key secrecy.

The app secret is the one that matters. It mints every ingest key the app will ever
have, so a leak means re-keying every deployed copy.

---

## Workflow A — triage what users are actually hitting

Start here when asked about reported bugs, production errors, or user feedback.

```sh
export TELEMETRY_COLLECTOR_URL=https://…     # the user's deployment
export TELEMETRY_COLLECTOR_TOKEN=ert_…       # ask the user if either isn't already set

telemetry-collector digest --app <app-id> --since 7d
```

`digest` is one call that returns the open issues, each already carrying a
representative event with its stack, plus the channels in play. **Prefer it over
walking `issues` and then fetching each one** — that turns one request into dozens.

Useful narrowing:

```sh
telemetry-collector digest --app x --since 24h --release 1.4.3   # did the new build break?
telemetry-collector issues --app x --kind feedback               # what users wrote, in words
telemetry-collector issues --app x --q "relay"                   # search titles and culprits
telemetry-collector issue <issue-id>                             # full samples for one issue
telemetry-collector digest --app x --json                        # raw, for programmatic use
```

### Reading the output

- **`count`** is the true number of occurrences. **`sample_count`** is how many full
  events were kept. They differ on purpose — a flood is coalesced, so a count of 40 000
  against 20 samples is normal and not data loss.
- **`attested`** means the report was signed with the app secret, so it provably came
  from your own code rather than from the open internet. When a report looks
  implausible, check this first.
- **`first_release` → `last_release`** tells you when a bug appeared. An issue spans
  versions deliberately; "first seen in 1.4.2" is the regression bisect you want.
- **Stack frames are innermost-last** (Sentry's order). The last frame is where it
  broke. `culprit` already picks it out.
- A `screenshot` attachment means a user sent a picture — fetch it with
  `GET /api/blob/<key>`, it is usually worth more than the text.

### Triage judgement

- Sort by `count × recency`, not count alone. A crash that stopped three weeks ago is
  probably already fixed.
- An issue whose `first_release` equals the newest release is a regression — treat it
  as more urgent than an older one with a bigger count.
- Feedback (`kind: feedback`) never coalesces, so ten similar entries really are ten
  people. That is a signal, not duplication.

---

## Workflow A2 — what is actually getting used

```sh
telemetry-collector usage --app <app-id> --since 30d
telemetry-collector usage --app <app-id> --groupBy release   # did 2.0 change behaviour?
telemetry-collector usage --app <app-id> --event gate.opened --interval hour
```

**Read these as estimates, and say so when you report them.** Analytics Engine samples
above roughly 100 events/second per app; the queries weight by the recorded sample
rate, so totals are statistically accurate but not exact. Never present them as a
count that reconciles with anything, and never compute a percentage to two decimals
off them.

Two more things that will mislead you if you forget them:

- **Counts can be inflated by anyone.** The ingest key is public, so a usage number is
  a lower-bound-ish signal about your own app, not a trustworthy metric about the
  world. Errors have the same property but you notice, because you read them.
- **Absence is not evidence.** Usage is shed before errors when the account is over
  budget, so a flat line may mean "nobody used it" _or_ "the collector stopped
  accepting". Check the budget level on the admin overview before concluding a
  feature is dead.

---

## Workflow B — add reporting to a project

### 1. Register the app (needs the user)

App registration is an admin action behind a passkey. Ask the user to register the app
and give you back the **app secret** (`ecs_…`), then put it straight into the repo's CI
secrets — as `TELEMETRY_COLLECTOR_APP_SECRET` — and nowhere else.

Pick an app id that is lowercase, hyphenated, and **contains no dots** (dots are the
ingest key's field separator). `gate-manager`, not `gate.manager`.

### 2. Derive the ingest key at build time

This is the step that makes the whole thing configurationless. No API call, no
registration of the version — the backend verifies the key and creates the channel on
first report.

```sh
telemetry-collector key --app gate-manager --channel "$VERSION"
# ek1.gate-manager.1.4.2.cc5g1c36bb3je8d7vmatrb59fm
```

`channel` is any label you want to slice by: a semver, a git SHA, `prod`/`staging`, or
`pr-812`. It may contain dots; the app id may not.

In GitHub Actions:

```yaml
- name: Derive ingest key
  run: echo "VITE_TELEMETRY_COLLECTOR_KEY=$(bunx @cinderblock/telemetry-collector-cli key \
    --app gate-manager --channel "${{ github.sha }}")" >> "$GITHUB_ENV"
  env:
    TELEMETRY_COLLECTOR_APP_SECRET: ${{ secrets.TELEMETRY_COLLECTOR_APP_SECRET }}
```

Use whatever env prefix the project's bundler actually inlines (`VITE_`, `NEXT_PUBLIC_`,
`PUBLIC_`…). Check that before writing it, rather than assuming.

### 3. Install and initialise

```sh
bun add @cinderblock/telemetry-collector
```

Browser:

```ts
import { init } from '@cinderblock/telemetry-collector';
import { installBrowserHandlers } from '@cinderblock/telemetry-collector/browser';

const client = init({
  endpoint: import.meta.env.VITE_TELEMETRY_COLLECTOR_URL, // required — no default exists
  ingestKey: import.meta.env.VITE_TELEMETRY_COLLECTOR_KEY,
  release: import.meta.env.VITE_GIT_SHA,
  environment: import.meta.env.MODE,
});
installBrowserHandlers(client);
```

Node / server-side — here, and **only** here, add attestation:

```ts
const client = init({
  endpoint: process.env.TELEMETRY_COLLECTOR_URL!,
  ingestKey: process.env.TELEMETRY_COLLECTOR_INGEST_KEY!,
  appSecret: process.env.TELEMETRY_COLLECTOR_APP_SECRET, // signs reports; server-side only
  release: process.env.GIT_SHA,
});
installNodeHandlers(client);
```

Initialise as early as possible — before the app's own imports run, or errors during
startup are not captured.

### 4. Usage tracking, if you want to know what gets used

```ts
client.track('gate.opened', { dims: { method: 'app' } });
client.track('session.duration', { value: seconds });
```

Batched automatically and flushed on `pagehide`; `track()` never awaits and never
throws. From a shell or CI: `telemetry-collector track --key $KEY ci.deploy
--dim.branch=master`.

Naming matters more than it looks — the event name is the grouping key, so keep a
small stable vocabulary (`noun.verb`, lowercase, dotted). Do **not** put an id or a
timestamp in the event name; that shatters one series into thousands. Put varying
parts in `dims`, and keep those low-cardinality too (`method`, `source`, `result` —
not `user_id`).

### 5. Feedback, if the app has users

```ts
import { captureScreenshot } from '@cinderblock/telemetry-collector/browser';

await client.sendFeedback({
  message: text,
  screenshot: (await captureScreenshot({ mode: 'dom' })) ?? undefined,
});
```

`mode: 'dom'` needs a renderer — pass one, or load `html2canvas` on the page. The SDK
bundles none deliberately. `mode: 'display'` is pixel-exact but needs a user gesture
and shows a picker, so only use it from a button the user pressed.

### 6. Anything not JavaScript

There is no SDK to install. One HTTP call is the whole protocol:

```sh
curl -X POST "$TELEMETRY_COLLECTOR_URL/i/$INGEST_KEY" \
  -H 'content-type: application/json' \
  -d '{"level":"error","message":"…","release":"1.4.2",
       "exception":{"type":"IOError","value":"…"}}'
```

Same for CI reporting its own failures: `telemetry-collector report --message "…"`, which
signs automatically when `TELEMETRY_COLLECTOR_APP_SECRET` is present.

---

## Things that will bite you

- **Don't add a proxy or a server-side relay to "hide" the ingest key.** It is public.
  A relay adds a hop, loses the client's country hint, and protects nothing.
- **Don't set `appSecret` in browser code.** Check where the code actually runs; an
  isomorphic file that is bundled for the client counts as browser code.
- **Don't send one report per retry in a loop.** The backend coalesces, but each
  attempt still costs the app's daily quota. Report once per distinct failure.
- **Don't put an app id with a dot in it** anywhere. Key parsing splits on the first
  dot for the app and the last for the MAC.
- **Never retire a channel to "clean up".** Retiring stops a version being collected,
  and it is a judgement call about whether anyone is still running it — which is why
  there is no CLI command for it and no automation behind it. If a channel looks
  stale, say so and let the user decide.
- **A 410 is not an error to fix.** It means that version was deliberately retired.
  Report it as such; do not retry, and do not "repair" the ingest key.
- **Don't put an id, a timestamp or a path into a usage event name.** It is the
  grouping key; high cardinality there makes the data useless and is the single most
  common analytics mistake. `page.view` with `dims: {route: '/gate'}`, never
  `page.view./gate/42`.
- **Don't quote usage numbers as exact.** They are sampled estimates.
- **Don't hardcode a backend hostname** in a project you are wiring up, and don't
  copy one out of another project. It goes in that project's env/CI config.
- **Don't treat a 429 as a bug.** It means the app's daily quota or the account budget
  is exhausted; back off and tell the user their budget needs raising.
- **A `stored: "counted"` response is success**, not failure. The report was counted but
  the governor declined to store its detail. Do not retry it.

## Reference

| Thing       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Backend     | `$TELEMETRY_COLLECTOR_URL` — no default; ask the user if unset                                                             |
| Ingest      | `POST /i/<ingestKey>` — JSON, or multipart with a `report` field plus `screenshot`                                         |
| Dataset     | `GET /api/digest`, `/api/issues`, `/api/issues/:id`, `/api/apps`, `/api/blob/:key`                                         |
| Auth (read) | `Authorization: Bearer ert_…`                                                                                              |
| CLI         | `bunx @cinderblock/telemetry-collector-cli help`                                                                           |
| Env         | `TELEMETRY_COLLECTOR_URL`, `TELEMETRY_COLLECTOR_TOKEN`, `TELEMETRY_COLLECTOR_APP_SECRET`, `TELEMETRY_COLLECTOR_INGEST_KEY` |
