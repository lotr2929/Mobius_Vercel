-- Mobius consensus orchestration schema
-- Run this in Supabase SQL Editor

-- Main query tracking
CREATE TABLE IF NOT EXISTS mobius_queries (
  query_id              BIGSERIAL PRIMARY KEY,
  user_id               UUID,
  user_query            TEXT NOT NULL,
  query_timestamp       TIMESTAMPTZ DEFAULT NOW(),
  query_domain          TEXT,

  -- Gate 1
  gate1_iterations      INT,
  gate1_passed          BOOLEAN,
  gate1_best_prompt     TEXT,
  gate1_best_prompt_score FLOAT,

  -- Gate 1.5
  gate1_5_passed        BOOLEAN,
  gate1_5_attempt       INT,
  gate1_5_final_sources TEXT[],

  -- User selection (Decision Point 2)
  user_selected_sources TEXT[],
  user_selection_timestamp TIMESTAMPTZ,

  -- Execution
  answers_generated     INT,

  -- Gate 2
  gate2_iterations      INT,
  gate2_passed          BOOLEAN,
  gate2_final_answer    TEXT,
  gate2_final_score     FLOAT,

  -- User decision (Decision Point 3)
  user_approved         BOOLEAN,
  user_feedback         TEXT,
  user_decision_timestamp TIMESTAMPTZ,

  -- Status
  final_status          TEXT DEFAULT 'in_progress',
  total_iterations      INT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Evaluation scores per gate per item
CREATE TABLE IF NOT EXISTS mobius_eval_scores (
  eval_id            BIGSERIAL PRIMARY KEY,
  query_id           BIGINT REFERENCES mobius_queries(query_id),
  gate               TEXT,
  iteration          INT,
  item_evaluated     TEXT,
  evaluator_id       INT,
  score              INT,
  accuracy_score     INT,
  relevance_score    INT,
  completeness_score INT,
  clarity_score      INT,
  reasoning          TEXT,
  eval_timestamp     TIMESTAMPTZ DEFAULT NOW()
);

-- Source consensus tracking
CREATE TABLE IF NOT EXISTS mobius_source_tracking (
  source_tracking_id BIGSERIAL PRIMARY KEY,
  query_id           BIGINT REFERENCES mobius_queries(query_id),
  attempt            INT,
  sources_evaluated  INT,
  consensus_sources  TEXT[],
  partial_sources    TEXT[],
  consensus_achieved BOOLEAN,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Model performance over time
CREATE TABLE IF NOT EXISTS mobius_model_performance (
  id              BIGSERIAL PRIMARY KEY,
  model_name      TEXT,
  domain          TEXT,
  task_type       TEXT,
  avg_score       FLOAT,
  score_range     FLOAT,
  eval_count      INT,
  deprecated      BOOLEAN DEFAULT FALSE,
  date_deprecated TIMESTAMPTZ,
  last_updated    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mobius_queries_user   ON mobius_queries(user_id);
CREATE INDEX IF NOT EXISTS idx_mobius_queries_status ON mobius_queries(final_status);
CREATE INDEX IF NOT EXISTS idx_mobius_eval_query     ON mobius_eval_scores(query_id);
CREATE INDEX IF NOT EXISTS idx_mobius_source_query   ON mobius_source_tracking(query_id);
