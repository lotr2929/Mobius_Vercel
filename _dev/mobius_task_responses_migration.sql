-- mobius_task_responses_migration.sql
-- Created: 24 Apr 2026 (Perth)
-- Run this ONCE in Supabase SQL Editor (lotr2929 / Mobius project).
--
-- Adds a table to persist every Task AI response so they can be reviewed later.
-- Logs both:
--   phase='suggestion' -- the 5 prompt-rewrite suggestions from Step 1
--   phase='execution'  -- the 5 final answers from Step 6, with evaluation scores
--
-- Linked to mobius_queries by query_id (cascade delete keeps things tidy).

CREATE TABLE IF NOT EXISTS mobius_task_responses (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_id     UUID REFERENCES mobius_queries(query_id) ON DELETE CASCADE,
    phase        TEXT NOT NULL CHECK (phase IN ('suggestion', 'execution')),
    ai_id        TEXT,            -- 'analyst' | 'researcher' | 'technical' | 'critical' | 'synthesiser'
    ai_label     TEXT,            -- human-readable, e.g. 'Analytical Specialist'
    model_used   TEXT,            -- e.g. 'Groq: Llama 3.3 70B', 'Gemini: Flash Latest'
    text         TEXT,            -- the AI's actual response
    failed       BOOLEAN DEFAULT FALSE,
    ms           INTEGER,         -- response time in milliseconds
    score_total  INTEGER,         -- 0-100, only populated for phase='execution'
    score_note   TEXT,            -- one-sentence evaluator note, only for phase='execution'
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_responses_query_id
    ON mobius_task_responses(query_id);

CREATE INDEX IF NOT EXISTS idx_task_responses_created_at
    ON mobius_task_responses(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_responses_phase
    ON mobius_task_responses(phase);

-- Useful queries:
--
-- All responses for a single query:
--   SELECT ai_label, model_used, phase, score_total, left(text, 200) AS preview
--   FROM mobius_task_responses
--   WHERE query_id = '<uuid>'
--   ORDER BY phase, ai_id;
--
-- Last 10 queries with all their Task AI outputs (join to see user_query):
--   SELECT q.user_query, r.phase, r.ai_label, r.model_used, r.score_total, r.text
--   FROM mobius_task_responses r
--   JOIN mobius_queries q ON q.query_id = r.query_id
--   WHERE q.query_timestamp > NOW() - INTERVAL '7 days'
--   ORDER BY q.query_timestamp DESC, r.phase, r.ai_id;
--
-- Average score per AI over time (quality tracking):
--   SELECT ai_label, model_used, COUNT(*) AS n,
--          ROUND(AVG(score_total)::numeric, 1) AS avg_score
--   FROM mobius_task_responses
--   WHERE phase = 'execution' AND score_total IS NOT NULL
--   GROUP BY ai_label, model_used
--   ORDER BY avg_score DESC;
