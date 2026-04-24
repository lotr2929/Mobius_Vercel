-- Adds the final_answer column to mobius_queries.
-- This column holds the polished prose answer the user saw in User Mode
-- (produced by buildUserAnswer in api/_exec.js). Storing it here means every
-- row in mobius_queries captures the complete exchange -- the user's query
-- AND the answer Mobius actually delivered -- which is what the future
-- user-profile summariser will read.
--
-- Safe to run multiple times; the IF NOT EXISTS guard is idempotent.
-- Run in Supabase SQL Editor.

ALTER TABLE mobius_queries
  ADD COLUMN IF NOT EXISTS final_answer TEXT;

COMMENT ON COLUMN mobius_queries.final_answer IS
  'Polished User Mode synthesis (buildUserAnswer output). NULL in Dev Mode.';
