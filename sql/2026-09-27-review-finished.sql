-- "Review finished" marker  (2026-09-27)
-- Run once in the Supabase SQL editor. Adds ONE empty column to two existing tables; nothing else changes.
--
-- When the researcher taps Save on the review sheet and no suggestion for a given question and Jim is left waiting,
-- reviewed_at is set on that Jim's answer row. The Desktop launcher then closes that Jim's idle window. (Without this
-- marker there would be no way to tell "reviewed, everything wiped" apart from "not reviewed yet".) If a follow-up is
-- asked afterwards the marker is cleared again, because the new report needs a new review.
ALTER TABLE research_results    ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;   -- everyday questions
ALTER TABLE comparative_answers ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;   -- comparative questions