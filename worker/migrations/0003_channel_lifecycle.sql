-- Channel lifecycle, and retention for the things nothing was pruning.
--
-- Two separate problems that share a table.
--
-- 1. RETIRING A CHANNEL. A version eventually stops being one you want reports from,
--    but that moment is a judgement call, not a date: people update at their own
--    pace, and the whole point of collecting from 1.4.2 is that some of them are
--    still running it. So retirement is **always an explicit act** — nothing in this
--    schema or the cron ever retires a channel on its own. The admin UI may *suggest*
--    a channel that has gone quiet; it never acts.
--
--    Retiring and deleting are also kept separate, because "stop accepting" and
--    "throw away what we have" are different decisions that usually want different
--    timing. `purge_after` expresses the graceful version: stop now, delete later.
--
-- 2. ISSUES WERE NEVER PRUNED. Events and blobs age out on `retentionDays`, but the
--    issues table had no expiry at all — a resolved crash from two years ago stayed
--    forever. Rows are small, so this is slow-motion, but it is unbounded.

ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | retired
ALTER TABLE channels ADD COLUMN retired_at INTEGER;
-- Unix seconds. When set and passed, the cron deletes this channel's events, blobs
-- and issues. NULL means "keep under the normal retention rules".
ALTER TABLE channels ADD COLUMN purge_after INTEGER;
-- Free-text, shown in the UI and returned by the API: "superseded by 2.0.0".
ALTER TABLE channels ADD COLUMN note TEXT;

CREATE INDEX channels_status ON channels (owner_id, status);
CREATE INDEX channels_purge ON channels (purge_after);

-- Lets the retention sweep find an app's issues without scanning, now that it has a
-- reason to: pruning by (app, channel) and by (status, last_seen).
CREATE INDEX issues_prune ON issues (owner_id, status, last_seen);
CREATE INDEX issues_channel ON issues (app_id, last_channel);
