-- Interactive art installation schema.

CREATE TABLE IF NOT EXISTS drawings (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'image/png',
  description  TEXT,          -- Claude-generated scene description
  style_notes  TEXT,          -- Claude-generated style profile
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  drawing_id        TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  contributor_name  TEXT,
  -- queued | generating | rejected | pending_review | approved | hidden
  status            TEXT NOT NULL DEFAULT 'queued',
  moderation_reason TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS derivatives (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL,
  drawing_id     TEXT NOT NULL,
  r2_key         TEXT NOT NULL,
  media_type     TEXT NOT NULL DEFAULT 'image/png',
  crafted_prompt TEXT,
  featured       INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_drawing ON submissions(drawing_id);
CREATE INDEX IF NOT EXISTS idx_derivatives_submission ON derivatives(submission_id);
CREATE INDEX IF NOT EXISTS idx_derivatives_created ON derivatives(created_at);
