-- ============================================================
--  migration v3: activity checks, strikes, staff chat
--  run once against the LIVE db:
--    wrangler d1 execute hub-db --remote --file=./schema-v3.sql
-- ============================================================

-- an "are you still active?" check that staff must confirm within 24h
CREATE TABLE IF NOT EXISTS activity_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by     TEXT    NOT NULL,
  created_by_name TEXT   NOT NULL,
  title          TEXT    NOT NULL,
  created        INTEGER NOT NULL,
  deadline       INTEGER NOT NULL,
  processed      INTEGER NOT NULL DEFAULT 0   -- 1 = strikes already handed out
);

-- who confirmed which check
CREATE TABLE IF NOT EXISTS check_responses (
  check_id   INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  user_name  TEXT    NOT NULL,
  responded  INTEGER NOT NULL,
  PRIMARY KEY (check_id, user_id)
);

-- strikes (3 = flagged)
CREATE TABLE IF NOT EXISTS staff_strikes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  user_name  TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  check_id   INTEGER,
  created    INTEGER NOT NULL
);

-- internal staff-only chat
CREATE TABLE IF NOT EXISTS staff_chat (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id     TEXT    NOT NULL,
  author_name   TEXT    NOT NULL,
  author_avatar TEXT,
  role          TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  created       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strikes_user ON staff_strikes(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_created ON staff_chat(created);
CREATE INDEX IF NOT EXISTS idx_checks_deadline ON activity_checks(deadline, processed);
