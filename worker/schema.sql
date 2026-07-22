-- ============================================================
--  discord community hub — D1 database schema
--  run once:  npx wrangler d1 execute hub-db --file=./schema.sql
--  (add --remote to also apply it to the live database)
-- ============================================================

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  user_name    TEXT    NOT NULL,
  user_avatar  TEXT,
  category     TEXT    NOT NULL,
  message      TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open',   -- open | closed
  created      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL,
  author_id      TEXT    NOT NULL,
  author_name    TEXT    NOT NULL,
  author_avatar  TEXT,
  is_staff       INTEGER NOT NULL DEFAULT 0,      -- 0 = member, 1 = staff
  text           TEXT    NOT NULL,
  created        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  user_name    TEXT    NOT NULL,
  user_avatar  TEXT,
  position     TEXT    NOT NULL,
  age          TEXT,
  answer       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | denied
  review_note  TEXT,
  reviewed_by  TEXT,
  created      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_apps_user ON applications(user_id);
