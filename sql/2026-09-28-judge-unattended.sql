-- Judge unattended runs: verified findings, dossier updates, review marker  (2026-09-28)
-- Run once. Additive only: widens two CHECK constraints on pending_proposals, adds one nullable column.
-- Nothing existing is touched or deleted.

-- 1) pending_proposals: allow ai_model 'judge' and two new categories -----------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.pending_proposals'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%ai_model%' OR pg_get_constraintdef(oid) ILIKE '%category%')
  LOOP
    EXECUTE format('ALTER TABLE public.pending_proposals DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE pending_proposals ADD CONSTRAINT pending_proposals_ai_model_check
  CHECK (ai_model IN ('claude','gpt','gemini','judge'));
ALTER TABLE pending_proposals ADD CONSTRAINT pending_proposals_category_check
  CHECK (category IN ('memory','open_question','contradiction','verified_finding','dossier_update'));

-- 2) comparative_evaluations: the same "reviewed" marker the other answer tables have -----------------------
ALTER TABLE comparative_evaluations ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
