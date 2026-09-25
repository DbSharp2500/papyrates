-- Jim job queue + login throttling  (2026-09-25)
-- Run once in the Supabase SQL editor. Additive only: three new tables, nothing existing is touched.
-- Access is service-role only (the site's server-side routes); RLS is on with no policies, and
-- anon/authenticated get no privileges.

-- 1) Jobs the dashboard queues and the always-on Desktop picks up ------------------------------
CREATE TABLE IF NOT EXISTS jim_jobs (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('answer','evaluate','open')),
  model         text NOT NULL CHECK (model IN ('claude','gpt','gemini','judge')),
  question_id   bigint,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','claimed','launched','failed','cancelled')),
  requested_by  text,
  claimed_at    timestamptz,
  launched_at   timestamptz,
  error_text    text,
  -- only three legal shapes: open a Jim / have a Jim answer a question / have Judge evaluate one
  CONSTRAINT jim_jobs_shape CHECK (
       (kind = 'open'     AND model <> 'judge' AND question_id IS NULL)
    OR (kind = 'answer'   AND model <> 'judge' AND question_id IS NOT NULL)
    OR (kind = 'evaluate' AND model = 'judge'  AND question_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jim_jobs_status_idx ON jim_jobs (status, id);

-- 2) One row: is the Desktop's launcher alive? ------------------------------------------------
CREATE TABLE IF NOT EXISTS jim_server (
  id         int PRIMARY KEY CHECK (id = 1),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  info       jsonb
);

-- 3) Failed/successful login attempts, for lockout ---------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  id   bigserial PRIMARY KEY,
  at   timestamptz NOT NULL DEFAULT now(),
  ip   text NOT NULL,
  ok   boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_at_idx ON login_attempts (at);

-- Access: server-side only -------------------------------------------------------------------
ALTER TABLE jim_jobs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE jim_server     ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE jim_jobs, jim_server, login_attempts FROM anon, authenticated;
GRANT  ALL ON TABLE jim_jobs, jim_server, login_attempts TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE jim_jobs_id_seq, login_attempts_id_seq TO service_role;
