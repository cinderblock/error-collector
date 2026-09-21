-- error-collector schema.
--
-- Two things shape this file:
--
-- 1. `owner_id` is carried on every table that holds data, and every query scopes by
--    it, even though there is exactly one owner today. Adding real accounts later is
--    then an addition rather than a migration of live data.
--
-- 2. The ingest hot path must cost as few *row writes* as possible, because D1's free
--    tier hard-fails at 100k row writes/day and an error collector is exactly the
--    workload that spikes. So the steady state for a report whose issue already exists
--    is two row writes: the issue upsert and the usage counter. `channels` is written
--    once when a channel first appears and is refreshed by the daily cron, never on
--    the hot path.

CREATE TABLE apps (
  id          TEXT PRIMARY KEY,               -- the app id embedded in ingest keys
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- AES-GCM sealed under the SECRET_KEK worker secret, so a D1 dump on its own
  -- does not yield the secrets that mint ingest keys.
  secret      TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',     -- per-app governor overrides, JSON
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX apps_owner ON apps (owner_id, archived_at);

-- Auto-created the first time a valid ingest key presents a channel we have not
-- seen. This is the "configurationless" property: a new version provisions itself.
CREATE TABLE channels (
  app_id      TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (app_id, channel)
);

-- `id` is the first 32 hex characters of `fingerprint`, which already hashes the app
-- id in — so it is globally unique, short enough for a URL, and known *before* the
-- row is written. That last property is what lets an event row reference its issue
-- inside the same batch, with no RETURNING round trip and no risk of a concurrent
-- insert winning and leaving the event pointing at a different id.
--
-- Consequently the upsert conflict target is the primary key, and `fingerprint` gets
-- a plain index rather than a second unique constraint: two unique constraints that
-- always fail together make SQLite's `ON CONFLICT` behaviour depend on which one it
-- happens to check first.
CREATE TABLE issues (
  id             TEXT PRIMARY KEY,             -- fingerprint[0..32]
  owner_id       TEXT NOT NULL,
  app_id         TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  fingerprint    TEXT NOT NULL,
  kind           TEXT NOT NULL,                -- error | feedback | message
  level          TEXT NOT NULL,
  title          TEXT NOT NULL,
  culprit        TEXT,
  status         TEXT NOT NULL DEFAULT 'open', -- open | resolved | ignored
  count          INTEGER NOT NULL DEFAULT 0,
  attested_count INTEGER NOT NULL DEFAULT 0,
  sample_count   INTEGER NOT NULL DEFAULT 0,   -- event rows actually stored
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  first_channel  TEXT NOT NULL,
  last_channel   TEXT NOT NULL,
  first_release  TEXT,
  last_release   TEXT,
  -- Set when resolved. A later event on a *different* release reopens the issue;
  -- one on the same release does not, so a slow rollout does not flap it.
  resolved_in    TEXT
);
CREATE INDEX issues_fingerprint ON issues (app_id, fingerprint);
CREATE INDEX issues_triage ON issues (owner_id, app_id, status, last_seen DESC);
CREATE INDEX issues_recent ON issues (owner_id, last_seen DESC);

-- Sampled occurrences. Never one row per report: the governor decides how many
-- samples an issue is worth, and `issues.count` carries the true total.
CREATE TABLE events (
  id        TEXT PRIMARY KEY,                  -- event_id from the report
  owner_id  TEXT NOT NULL,
  issue_id  TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  app_id    TEXT NOT NULL,
  channel   TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  attested  INTEGER NOT NULL DEFAULT 0,        -- 1 = signed with the app secret
  payload   TEXT NOT NULL                      -- StoredEvent, JSON
);
CREATE INDEX events_issue ON events (issue_id, ts DESC);
CREATE INDEX events_prune ON events (ts);

CREATE TABLE blobs (
  key          TEXT PRIMARY KEY,               -- R2 object key
  owner_id     TEXT NOT NULL,
  event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,                  -- screenshot | har | console | attachment
  bytes        INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX blobs_event ON blobs (event_id);
CREATE INDEX blobs_prune ON blobs (created_at);

-- Read tokens for agents and CI. Stored only as a digest, so a database leak
-- yields nothing usable. Independent of app secrets so revoking one never forces
-- re-keying deployed clients.
CREATE TABLE read_tokens (
  hash         TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- JSON: {"apps": ["gate-manager"] | ["*"], "write": false}
  -- `write` is opt-in per token. An agent triaging errors only needs to read; one
  -- that should also be able to resolve an issue it has fixed gets its own token,
  -- so the common case cannot mutate anything.
  scope        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX read_tokens_owner ON read_tokens (owner_id, revoked_at);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,               -- WebAuthn credential id, base64url
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  public_key   TEXT NOT NULL,                  -- COSE key, base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                           -- JSON array; lets the browser prompt for the right device
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX devices_owner ON devices (owner_id);

-- WebAuthn challenges. Held server-side and single-use, because a challenge a
-- client could choose or replay is not a challenge: the whole point is that the
-- authenticator signed something only this server could have asked for.
CREATE TABLE auth_state (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                    -- registration | authentication
  value      TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_state_prune ON auth_state (expires_at);

-- Single-use links that let an already-trusted device enrol a new one, so the
-- bootstrap token is needed exactly once in the service's life.
CREATE TABLE device_invites (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  device_id  TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_device ON sessions (device_id);
CREATE INDEX sessions_prune ON sessions (expires_at);

-- Runtime configuration, including every budget-governor knob. Defaults self-seed
-- on first read, so a fresh deploy needs no manual SQL.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                    -- JSON
  updated_at INTEGER NOT NULL
);

-- Synchronous usage accounting, for per-app quotas that must be enforced now
-- rather than at the next cron tick. Account-wide totals live here too, under
-- app_id ''. One row per (day, app), so this stays tiny.
CREATE TABLE usage_daily (
  day          TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  app_id       TEXT NOT NULL,                  -- '' = account-wide
  reports      INTEGER NOT NULL DEFAULT 0,
  stored       INTEGER NOT NULL DEFAULT 0,     -- reports that produced an event row
  rows_written INTEGER NOT NULL DEFAULT 0,
  blob_bytes   INTEGER NOT NULL DEFAULT 0,
  dropped      INTEGER NOT NULL DEFAULT 0,     -- counted but not stored
  rejected     INTEGER NOT NULL DEFAULT 0,     -- refused outright
  PRIMARY KEY (day, app_id)
);
CREATE INDEX usage_prune ON usage_daily (day);
