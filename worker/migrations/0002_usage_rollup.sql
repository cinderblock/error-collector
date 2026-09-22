-- Daily usage totals, copied out of Analytics Engine before they expire.
--
-- AE keeps 90 days and offers no retention knob. Anything wanted beyond that has to
-- be copied into D1 while it still exists — and a rollup added later cannot recover
-- what has already aged out, which is why this ships with the feature rather than
-- after someone notices a gap.
--
-- One row per (app, event, day), so this stays tiny: a hundred apps with fifty event
-- names each is 5k rows/day, a rounding error against D1's 5 GB. The write happens
-- once a day from cron, never on the ingest path — usage ingest writes no D1 at all,
-- and that property is the whole reason the feature is affordable.
CREATE TABLE usage_rollup (
  day      TEXT NOT NULL,                   -- YYYY-MM-DD, UTC
  app_id   TEXT NOT NULL,
  event    TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  -- Both already weighted by AE's _sample_interval at query time, so these are
  -- estimates of the true totals rather than raw row counts.
  events   REAL NOT NULL DEFAULT 0,
  value    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app_id, event)
);
CREATE INDEX usage_rollup_app ON usage_rollup (owner_id, app_id, day);
CREATE INDEX usage_rollup_event ON usage_rollup (owner_id, app_id, event, day);
