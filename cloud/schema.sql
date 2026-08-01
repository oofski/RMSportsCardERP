-- RM Operations relay — D1 schema, with the reasoning.
--
-- DO NOT PASTE THIS FILE INTO THE D1 CONSOLE. Paste `schema.d1.sql` instead —
-- same statements, no comments. Copying from a rendered file (a browser, a
-- chat window) often flattens the line breaks, and once that happens the first
-- `--` comments out everything after it on what is now a single line. The
-- console then receives nothing but a comment and answers "Requests without any
-- query are not supported", which sounds like a Cloudflare fault and is not.
--
-- This copy is for reading. Two tables, and that is the whole cloud-side data
-- model.
--
-- The relay stores rows as opaque JSON keyed by (kind, id). It deliberately
-- does NOT mirror the app's forty tables: a schema here would need migrating in
-- lockstep with the app, and the moment the two drifted the relay would start
-- rejecting rows from whichever laptop updated first. Storing the row as text
-- means a new column added in the app on Tuesday travels on Tuesday, with no
-- change here at all.

CREATE TABLE IF NOT EXISTS sync_rows (
  kind       TEXT    NOT NULL,          -- the app's table name
  id         TEXT    NOT NULL,          -- the record's primary key
  seq        INTEGER NOT NULL,          -- delivery order; see sync_seq
  updated_at TEXT    NOT NULL,          -- laptop wall-clock; settles conflicts
  deleted    INTEGER NOT NULL DEFAULT 0,-- 1 = tombstone, data is NULL
  device     TEXT,                      -- which laptop sent it
  data       TEXT,                      -- the row, as JSON
  PRIMARY KEY (kind, id)
);

-- Pull is "everything after my cursor, in order", so this index is the one that
-- decides whether a sync round is fast.
CREATE INDEX IF NOT EXISTS idx_sync_rows_seq ON sync_rows (seq);

-- The delivery counter.
--
-- A single row holding a number that only goes up. Every accepted push takes
-- the next N values, so each laptop can say "give me everything above 4,812"
-- and get exactly what it has not seen — no timestamps, no clock comparison, no
-- ambiguity when two laptops write in the same millisecond.
CREATE TABLE IF NOT EXISTS sync_seq (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);
