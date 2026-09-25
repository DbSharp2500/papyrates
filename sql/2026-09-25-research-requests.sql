-- Research requests, suggestions review, auto-Judge and phone alerts  (2026-09-25)
-- Run once in the Supabase SQL editor, AFTER 2026-09-25-jim-job-queue.sql.
-- Adds five new tables and widens the job list (jim_jobs) to allow a new kind of job, "ask".
-- Nothing else existing is changed: comparative_questions / comparative_answers / the memory tables are untouched.
-- Access is service-role only (the site's server routes); RLS is on with no policies and anon/authenticated get nothing.

-- 1) Everyday questions asked from the website (the Desktop launcher works through these) -----------
CREATE TABLE IF NOT EXISTS research_requests (
  id                      bigserial PRIMARY KEY,
  created_at              timestamptz NOT NULL DEFAULT now(),
  question_text           text NOT NULL,
  topic                   text,
  requested_by            text,
  comparative_question_id bigint REFERENCES comparative_questions(id) ON DELETE SET NULL   -- set if promoted to comparative
);

-- 2) Each Jim's answer to a research request (same columns as comparative_answers, so promoting is a straight copy)
CREATE TABLE IF NOT EXISTS research_results (
  id               bigserial PRIMARY KEY,
  request_id       bigint NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  ai_model         text NOT NULL CHECK (ai_model IN ('claude','gpt','gemini')),
  summary          text,
  key_findings     text,
  document_ids     text,
  output_file_url  text,
  criteria_applied text,
  research_log_url text,
  answered_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, ai_model)
);

-- 3) Things a Jim suggests saving after an unattended run, waiting for your Accept / Decline ---------
--    fields: memory        -> {"content": "..."}
--            open_question -> {"question": "...", "context": "..."}
--            contradiction -> {"standard_account": "...", "database_shows": "...", "source_documents": "...", "confidence": "..."}
CREATE TABLE IF NOT EXISTS pending_proposals (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  request_id  bigint REFERENCES research_requests(id)     ON DELETE CASCADE,
  question_id bigint REFERENCES comparative_questions(id) ON DELETE CASCADE,
  ai_model    text NOT NULL CHECK (ai_model IN ('claude','gpt','gemini')),
  category    text NOT NULL CHECK (category IN ('memory','open_question','contradiction')),
  topic       text,
  fields      jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  decided_at  timestamptz,
  CONSTRAINT pending_proposals_one_source CHECK (num_nonnulls(request_id, question_id) = 1)
);
CREATE INDEX IF NOT EXISTS pending_proposals_status_idx ON pending_proposals (status, id);

-- 4) Comparative questions that should get the Judge automatically once all three Jims have answered ---
CREATE TABLE IF NOT EXISTS comparative_auto_judge (
  question_id     bigint PRIMARY KEY REFERENCES comparative_questions(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  judge_queued_at timestamptz
);

-- 5) Which phone alerts have already been sent, so each one goes out only once ---------------------------
CREATE TABLE IF NOT EXISTS push_log (
  key      text PRIMARY KEY,
  sent_at  timestamptz NOT NULL DEFAULT now()
);

-- 6) The job list learns about "ask" jobs (a Jim answering a research request) ---------------------------
ALTER TABLE jim_jobs ADD COLUMN IF NOT EXISTS request_id bigint REFERENCES research_requests(id) ON DELETE CASCADE;

-- drop the old kind / shape checks (found by content, so their exact names do not matter), then add the wider ones
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.jim_jobs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.jim_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_kind_check CHECK (kind IN ('answer','evaluate','open','ask'));
ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_shape CHECK (
     (kind = 'open'     AND model <> 'judge' AND question_id IS NULL     AND request_id IS NULL)
  OR (kind = 'answer'   AND model <> 'judge' AND question_id IS NOT NULL AND request_id IS NULL)
  OR (kind = 'evaluate' AND model = 'judge'  AND question_id IS NOT NULL AND request_id IS NULL)
  OR (kind = 'ask'      AND model <> 'judge' AND question_id IS NULL     AND request_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS jim_jobs_request_idx ON jim_jobs (request_id);

-- Access: server-side only ------------------------------------------------------------------------------
ALTER TABLE research_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_proposals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparative_auto_judge ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_log              ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE research_requests, research_results, pending_proposals, comparative_auto_judge, push_log FROM anon, authenticated;
GRANT  ALL ON TABLE research_requests, research_results, pending_proposals, comparative_auto_judge, push_log TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE research_requests_id_seq, research_results_id_seq, pending_proposals_id_seq TO service_role;
