-- Follow-up questions on a finished report  (2026-09-26)
-- Run once in the Supabase SQL editor, AFTER 2026-09-25-research-requests.sql.
-- Adds one new table (followups) and lets the job list carry a new kind of job, "followup".
-- Nothing existing is deleted or emptied. Access is service-role only, like the other new tables.

-- 1) What the researcher asked, and what the Jim answered ----------------------------------------------------
CREATE TABLE IF NOT EXISTS followups (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  request_id   bigint NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  ai_model     text   NOT NULL CHECK (ai_model IN ('claude','gpt','gemini')),
  message      text   NOT NULL,
  reply        text,                 -- the Jim's short answer / warning, written by the Jim
  finished_at  timestamptz           -- set by the Jim LAST: "the updated report is written"
);
CREATE INDEX IF NOT EXISTS followups_request_idx ON followups (request_id, ai_model, id);

-- 2) The job list learns about "followup" jobs -------------------------------------------------------------
ALTER TABLE jim_jobs ADD COLUMN IF NOT EXISTS followup_id bigint REFERENCES followups(id) ON DELETE CASCADE;

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

ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_kind_check CHECK (kind IN ('answer','evaluate','open','ask','followup'));
ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_shape CHECK (
     (kind = 'open'     AND model <> 'judge' AND question_id IS NULL     AND request_id IS NULL     AND followup_id IS NULL)
  OR (kind = 'answer'   AND model <> 'judge' AND question_id IS NOT NULL AND request_id IS NULL     AND followup_id IS NULL)
  OR (kind = 'evaluate' AND model = 'judge'  AND question_id IS NOT NULL AND request_id IS NULL     AND followup_id IS NULL)
  OR (kind = 'ask'      AND model <> 'judge' AND question_id IS NULL     AND request_id IS NOT NULL AND followup_id IS NULL)
  OR (kind = 'followup' AND model <> 'judge' AND question_id IS NULL     AND request_id IS NULL     AND followup_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS jim_jobs_followup_idx ON jim_jobs (followup_id);

-- Access: server-side only ------------------------------------------------------------------------------------
ALTER TABLE followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE followups FROM anon, authenticated;
GRANT  ALL ON TABLE followups TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE followups_id_seq TO service_role;
