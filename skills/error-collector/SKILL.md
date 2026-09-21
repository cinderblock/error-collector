---
name: error-collector
description: Wire a project up to the error-collector backend, or pull its collected errors and user feedback for triage. Use when asked to "add error reporting", "collect crashes/feedback from this app", "set up error-collector", "what errors are users hitting", "check reported bugs", "triage production errors", or when investigating a bug that users have reported from a deployed app.
---

# error-collector

A self-hosted crash and feedback collector running on Cloudflare at
`error-collector.tomsawyerlabs.com`. This skill covers the two things an agent does
with it: **wiring a project up to it**, and **reading the data to fix things**.

## Credentials — read this before touching anything

Three kinds, and mixing them up is the one genuinely damaging mistake available here.

|            | Looks like                  | Where it belongs                       | Never                                          |
| ---------- | --------------------------- | -------------------------------------- | ---------------------------------------------- |
| App secret | `ecs_…`                     | CI secrets, password store             | **never** in a client bundle, a repo, or a log |
| Ingest key | `ek1.<app>.<channel>.<mac>` | committed config, client bundles       | — it is public by design                       |
| Read token | `ert_…`                     | your own env (`ERROR_COLLECTOR_TOKEN`) | not in the app                                 |

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
export ERROR_COLLECTOR_TOKEN=ert_…       # ask the user if it isn't already set

error-collector digest --app <app-id> --since 7d
```

`digest` is one call that returns the open issues, each already carrying a
representative event with its stack, plus the channels in play. **Prefer it over
walking `issues` and then fetching each one** — that turns one request into dozens.

Useful narrowing:

```sh
error-collector digest --app x --since 24h --release 1.4.3   # did the new build break?
error-collector issues --app x --kind feedback               # what users wrote, in words
error-collector issues --app x --q "relay"                   # search titles and culprits
error-collector issue <issue-id>                             # full samples for one issue
error-collector digest --app x --json                        # raw, for programmatic use
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

## Workflow B — add reporting to a project

### 1. Register the app (needs the user)

App registration is an admin action behind a passkey. Ask the user to register the app
and give you back the **app secret** (`ecs_…`), then put it straight into the repo's CI
secrets — as `ERROR_COLLECTOR_APP_SECRET` — and nowhere else.

Pick an app id that is lowercase, hyphenated, and **contains no dots** (dots are the
ingest key's field separator). `gate-manager`, not `gate.manager`.

### 2. Derive the ingest key at build time

This is the step that makes the whole thing configurationless. No API call, no
registration of the version — the backend verifies the key and creates the channel on
first report.

```sh
error-collector key --app gate-manager --channel "$VERSION"
# ek1.gate-manager.1.4.2.cc5g1c36bb3je8d7vmatrb59fm
```

`channel` is any label you want to slice by: a semver, a git SHA, `prod`/`staging`, or
`pr-812`. It may contain dots; the app id may not.

In GitHub Actions:

```yaml
- name: Derive ingest key
  run: echo "VITE_ERROR_COLLECTOR_KEY=$(bunx @tomsawyerlabs/error-collector-cli key \
    --app gate-manager --channel "${{ github.sha }}")" >> "$GITHUB_ENV"
  env:
    ERROR_COLLECTOR_APP_SECRET: ${{ secrets.ERROR_COLLECTOR_APP_SECRET }}
```

Use whatever env prefix the project's bundler actually inlines (`VITE_`, `NEXT_PUBLIC_`,
`PUBLIC_`…). Check that before writing it, rather than assuming.

### 3. Install and initialise

```sh
bun add @tomsawyerlabs/error-collector
```

Browser:

```ts
import { init } from '@tomsawyerlabs/error-collector';
import { installBrowserHandlers } from '@tomsawyerlabs/error-collector/browser';

const client = init({
  ingestKey: import.meta.env.VITE_ERROR_COLLECTOR_KEY,
  release: import.meta.env.VITE_GIT_SHA,
  environment: import.meta.env.MODE,
});
installBrowserHandlers(client);
```

Node / server-side — here, and **only** here, add attestation:

```ts
const client = init({
  ingestKey: process.env.ERROR_COLLECTOR_INGEST_KEY!,
  appSecret: process.env.ERROR_COLLECTOR_APP_SECRET, // signs reports; server-side only
  release: process.env.GIT_SHA,
});
installNodeHandlers(client);
```

Initialise as early as possible — before the app's own imports run, or errors during
startup are not captured.

### 4. Feedback, if the app has users

```ts
import { captureScreenshot } from '@tomsawyerlabs/error-collector/browser';

await client.sendFeedback({
  message: text,
  screenshot: (await captureScreenshot({ mode: 'dom' })) ?? undefined,
});
```

`mode: 'dom'` needs a renderer — pass one, or load `html2canvas` on the page. The SDK
bundles none deliberately. `mode: 'display'` is pixel-exact but needs a user gesture
and shows a picker, so only use it from a button the user pressed.

### 5. Anything not JavaScript

There is no SDK to install. One HTTP call is the whole protocol:

```sh
curl -X POST "https://error-collector.tomsawyerlabs.com/i/$INGEST_KEY" \
  -H 'content-type: application/json' \
  -d '{"level":"error","message":"…","release":"1.4.2",
       "exception":{"type":"IOError","value":"…"}}'
```

Same for CI reporting its own failures: `error-collector report --message "…"`, which
signs automatically when `ERROR_COLLECTOR_APP_SECRET` is present.

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
- **Don't treat a 429 as a bug.** It means the app's daily quota or the account budget
  is exhausted; back off and tell the user their budget needs raising.
- **A `stored: "counted"` response is success**, not failure. The report was counted but
  the governor declined to store its detail. Do not retry it.

## Reference

| Thing       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Backend     | `https://error-collector.tomsawyerlabs.com`                                                                |
| Ingest      | `POST /i/<ingestKey>` — JSON, or multipart with a `report` field plus `screenshot`                         |
| Dataset     | `GET /api/digest`, `/api/issues`, `/api/issues/:id`, `/api/apps`, `/api/blob/:key`                         |
| Auth (read) | `Authorization: Bearer ert_…`                                                                              |
| CLI         | `bunx @tomsawyerlabs/error-collector-cli help`                                                             |
| Env         | `ERROR_COLLECTOR_URL`, `ERROR_COLLECTOR_TOKEN`, `ERROR_COLLECTOR_APP_SECRET`, `ERROR_COLLECTOR_INGEST_KEY` |
