-- Explorer (2026-09-29)
-- A self-directed research loop that runs overnight on the server. Run once.
-- Additive only: four new tables and two new login roles. Nothing existing is altered.
--
-- Two logins, deliberately separate:
--   explorer         - used by the explorer itself (through its own query tool). READS the archive and the memory
--                      tables; may INSERT/UPDATE only its own memory/fragment/person tables. No DELETE anywhere:
--                      it retires a memory by marking it superseded, so its changes of mind stay visible.
--   explorer_runner  - used by the loop script only. Records each round, and reads jim_jobs so the explorer can
--                      step aside when a real Claude/Judge job is waiting.
-- Both are created WITHOUT a password here (this file is in a public repo). Passwords are set separately and
-- live only in the server's explorer config.

-- 1) Tables ---------------------------------------------------------------------------------------------------

-- One row per round of the loop. Written by the runner, never by the explorer.
CREATE TABLE IF NOT EXISTS explorer_rounds (
  id             bigserial PRIMARY KEY,
  round_no       int NOT NULL UNIQUE,
  kind           text NOT NULL DEFAULT 'explore' CHECK (kind IN ('explore','audit')),
  phase          text CHECK (phase IN ('inventory','ownership','authenticity','origin')),
  question       text,
  rationale      text,          -- how this question advances the goal (shown in the notification)
  answer_summary text,
  next_question  text,
  report_path    text,
  session_id     text,          -- the Claude Code session that ran this round
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','stopped','limited')),
  error_text     text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

-- What it has learned. kind: fact / method (a lesson about HOW to research) / lead (a parked tangent).
CREATE TABLE IF NOT EXISTS explorer_memory (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  round_no       int,
  kind           text NOT NULL CHECK (kind IN ('fact','method','lead')),
  topic          text NOT NULL,
  content        text NOT NULL,
  evidence_level text NOT NULL CHECK (evidence_level IN ('verified','reported','inferred')),
  sources        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired')),
  superseded_by  bigint REFERENCES explorer_memory(id),
  status_reason  text
);
CREATE INDEX IF NOT EXISTS explorer_memory_topic_idx ON explorer_memory (status, kind, topic);

-- The catalogue: one row per fragment that has entered the market since the late 1990s.
CREATE TABLE IF NOT EXISTS explorer_fragments (
  id                   bigserial PRIMARY KEY,
  label                text NOT NULL UNIQUE,   -- its own stable name, e.g. 'MOTB Genesis 31:23-25'
  text_identification  text,                   -- which text / passage the fragment is presented as
  identifiers          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- inventory numbers, catalogue ids, aliases
  current_holder       text,
  first_appearance     text,                   -- first documented market appearance (free text: dates are fuzzy)
  custody_chain        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{holder, from, to, how, evidence_level, sources}]
  provenance_stories   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{told_by, date, story, sources}] - every version
  authenticity_status  text NOT NULL DEFAULT 'unknown' CHECK (authenticity_status IN
                         ('published_forgery','suspected','disputed','no_analysis','accepted_authentic','unknown')),
  authenticity_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  how_identified       text,                   -- how it got onto the list, and which sources were searched
  notes                text,
  created_round        int,
  updated_round        int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Persons of interest for the origin question. Graded evidence for AND against - never a bare accusation.
CREATE TABLE IF NOT EXISTS explorer_persons (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  role          text,                          -- dealer, broker, collector, scholar, ...
  summary       text,
  evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{claim, grade: documented|reported|circumstantial|speculative,
                                                     --   direction: for|against, sources}]
  created_round int,
  updated_round int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Same convention as every other table: no access from the public API keys; the site's server key can read.
ALTER TABLE explorer_rounds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE explorer_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE explorer_fragments ENABLE ROW LEVEL SECURITY;
ALTER TABLE explorer_persons   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE explorer_rounds, explorer_memory, explorer_fragments, explorer_persons FROM anon, authenticated;
GRANT  ALL ON TABLE explorer_rounds, explorer_memory, explorer_fragments, explorer_persons TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE explorer_rounds_id_seq, explorer_memory_id_seq,
                                 explorer_fragments_id_seq, explorer_persons_id_seq TO service_role;

-- 2) Logins ---------------------------------------------------------------------------------------------------
-- BYPASSRLS because every archive table has RLS on with no policies; what they can touch is decided entirely by
-- the GRANTs below (no default privileges, no ownership, no DELETE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer') THEN
    CREATE ROLE explorer LOGIN BYPASSRLS NOINHERIT CONNECTION LIMIT 6;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer_runner') THEN
    CREATE ROLE explorer_runner LOGIN BYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  END IF;
END $$;

ALTER ROLE explorer        SET statement_timeout = '60s';
ALTER ROLE explorer        SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE explorer_runner SET statement_timeout = '30s';

GRANT USAGE ON SCHEMA public TO explorer, explorer_runner;

-- explorer: read the archive, corrections, all memory tables, and earlier research answers
GRANT SELECT ON TABLE
  letters, people, manuscripts, institutions, letter_people, letter_manuscripts,
  manuscript_institutions, manuscript_registry, dossiers,
  extraction_entities, extraction_provenance_claims, extraction_transactions, extraction_manuscript_references,
  researcher_knowledge, open_research_questions, contradictions, verified_findings,
  claude_memory, gpt_memory, gemini_memory, research_memory,
  comparative_questions, comparative_answers, comparative_evaluations,
  research_requests, research_results
TO explorer;
-- explorer: its own tables
GRANT SELECT                 ON TABLE explorer_rounds                                      TO explorer;
GRANT SELECT, INSERT, UPDATE ON TABLE explorer_memory, explorer_fragments, explorer_persons TO explorer;
GRANT USAGE, SELECT ON SEQUENCE explorer_memory_id_seq, explorer_fragments_id_seq, explorer_persons_id_seq TO explorer;

-- explorer_runner: the round log, a look at the job queue, and read access to the catalogue for progress counts
GRANT SELECT, INSERT, UPDATE ON TABLE explorer_rounds TO explorer_runner;
GRANT USAGE, SELECT ON SEQUENCE explorer_rounds_id_seq TO explorer_runner;
GRANT SELECT ON TABLE jim_jobs, explorer_memory, explorer_fragments, explorer_persons TO explorer_runner;
-- ... and the tables whose rows mark a launched job as finished (so "real work in progress" means exactly that:
-- a launched job whose answer / verdict / reply has not landed yet)
GRANT SELECT ON TABLE research_results, comparative_answers, comparative_evaluations, followups, judge_followups
TO explorer_runner;

-- 2026-09-30: a third kind of round, the periodic strategy review (every 30th round; see the Explorer persona)
ALTER TABLE explorer_rounds DROP CONSTRAINT IF EXISTS explorer_rounds_kind_check;
ALTER TABLE explorer_rounds ADD CONSTRAINT explorer_rounds_kind_check CHECK (kind IN ('explore','audit','strategy'));