-- create_code_index.sql
-- Run in General Supabase (same project as memory tables).
-- Creates the code_index table and semantic search RPC.

-- ============================================================
-- STEP 1: Create table
-- ============================================================

CREATE TABLE IF NOT EXISTS code_index (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,
  project      TEXT        NOT NULL,
  file_path    TEXT        NOT NULL,
  summary      TEXT,
  symbols      TEXT[]      DEFAULT '{}',
  dependencies TEXT[]      DEFAULT '{}',
  line_count   INT         DEFAULT 0,
  embedding    vector(768),
  indexed_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, project, file_path)
);

CREATE INDEX IF NOT EXISTS code_index_embedding_idx
  ON code_index USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

CREATE INDEX IF NOT EXISTS code_index_project_idx
  ON code_index (user_id, project);

-- ============================================================
-- STEP 2: Semantic search RPC
-- ============================================================

CREATE OR REPLACE FUNCTION search_code_index(
  query_embedding vector(768),
  user_id_param   text,
  project_param   text,
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  id           uuid,
  file_path    text,
  summary      text,
  symbols      text[],
  similarity   float
)
LANGUAGE sql STABLE
AS $$
  SELECT id, file_path, summary, symbols,
         1 - (embedding <=> query_embedding) AS similarity
  FROM code_index
  WHERE user_id = user_id_param
    AND project = project_param
    AND embedding IS NOT NULL
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
