-- Judge follow-ups (2026-09-28)
-- Run once. Additive only: one new table, two new nullable columns, widened kind/shape checks on jim_jobs.

-- 1) Judge's own follow-up thread per comparative question --------------------------------------------------
CREATE TABLE IF NOT EXISTS judge_followups (
  id                      bigserial PRIMARY KEY,
  created_at              timestamptz NOT NULL DEFAULT now(),
  comparative_question_id bigint NOT NULL REFERENCES comparative_questions(id) ON DELETE CASCADE,
  message                 text NOT NULL,
  reply                   text,
  finished_at             timestamptz
);
CREATE INDEX IF NOT EXISTS judge_followups_question_idx ON judge_followups (comparative_question_id, id);

-- 2) Judge's evaluation remembers its own Claude Code session id, so a follow-up can RESUME it (full verification
--    history intact) instead of starting over. Nullable: older verdicts (written before this existed) have none.
ALTER TABLE comparative_evaluations ADD COLUMN IF NOT EXISTS session_id text;

-- 3) jim_jobs learns a new kind, 'judge_followup' -----------------------------------------------------------
ALTER TABLE jim_jobs ADD COLUMN IF NOT EXISTS judge_followup_id bigint REFERENCES judge_followups(id) ON DELETE CASCADE;

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

ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_kind_check
  CHECK (kind IN ('answer','evaluate','open','ask','followup','judge_followup'));
ALTER TABLE jim_jobs ADD CONSTRAINT jim_jobs_shape CHECK (
     (kind = 'open'           AND model <> 'judge' AND question_id IS NULL     AND request_id IS NULL AND followup_id IS NULL AND judge_followup_id IS NULL)
  OR (kind = 'answer'         AND model <> 'judge' AND question_id IS NOT NULL AND request_id IS NULL AND followup_id IS NULL AND judge_followup_id IS NULL)
  OR (kind = 'evaluate'       AND model = 'judge'  AND question_id IS NOT NULL AND request_id IS NULL AND followup_id IS NULL AND judge_followup_id IS NULL)
  OR (kind = 'ask'            AND model <> 'judge' AND question_id IS NULL     AND request_id IS NOT NULL AND followup_id IS NULL AND judge_followup_id IS NULL)
  OR (kind = 'followup'       AND model <> 'judge' AND question_id IS NULL     AND request_id IS NULL AND followup_id IS NOT NULL AND judge_followup_id IS NULL)
  OR (kind = 'judge_followup' AND model = 'judge'  AND question_id IS NOT NULL AND request_id IS NULL AND followup_id IS NULL AND judge_followup_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS jim_jobs_judge_followup_idx ON jim_jobs (judge_followup_id);

-- Access: server-side only
ALTER TABLE judge_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE judge_followups FROM anon, authenticated;
GRANT  ALL ON TABLE judge_followups TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE judge_followups_id_seq TO service_role;
