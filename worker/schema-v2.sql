-- ============================================================
--  migration: announcements + staff activity
--  run once against the LIVE db:
--    wrangler d1 execute hub-db --remote --file=./schema-v2.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id    TEXT    NOT NULL,
  author_name  TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  created      INTEGER NOT NULL
);

-- one row per staff member, updated every time they load the site
CREATE TABLE IF NOT EXISTS staff_activity (
  user_id     TEXT PRIMARY KEY,
  user_name   TEXT NOT NULL,
  user_avatar TEXT,
  role        TEXT NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_created ON announcements(created);
