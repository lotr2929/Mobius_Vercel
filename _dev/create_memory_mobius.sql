-- create_memory_mobius.sql
-- Step 1: Create the memory_mobius table (same schema as memory_project)
-- Step 2: Update the match_memories RPC to include memory_mobius in the UNION
-- Step 3: Seed initial Mobius self-awareness entries
-- Run all three steps in the Supabase SQL editor.

-- ============================================================
-- STEP 1: Create table
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_mobius (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  tags        TEXT[]      DEFAULT '{}',
  app_ids     TEXT[]      DEFAULT '{}',   -- which Mobius app(s) this relates to
  file_refs   TEXT[]      DEFAULT '{}',
  embedding   vector(768),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_mobius_embedding_idx
  ON memory_mobius USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

CREATE INDEX IF NOT EXISTS memory_mobius_user_idx
  ON memory_mobius (user_id);

-- ============================================================
-- STEP 2: Replace match_memories RPC to include memory_mobius
-- Drop existing function first, then recreate with 5-table UNION.
-- ============================================================

DROP FUNCTION IF EXISTS match_memories(vector, text, int);

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(768),
  user_id_param   text,
  match_count     int DEFAULT 15
)
RETURNS TABLE (
  id          uuid,
  content     text,
  table_name  text,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT id, content, 'user' AS table_name,
         1 - (embedding <=> query_embedding) AS similarity
  FROM memory_user
  WHERE user_id = user_id_param AND embedding IS NOT NULL

  UNION ALL

  SELECT id, content, 'tools' AS table_name,
         1 - (embedding <=> query_embedding) AS similarity
  FROM memory_tools
  WHERE user_id = user_id_param AND embedding IS NOT NULL

  UNION ALL

  SELECT id, content, 'project' AS table_name,
         1 - (embedding <=> query_embedding) AS similarity
  FROM memory_project
  WHERE user_id = user_id_param AND embedding IS NOT NULL

  UNION ALL

  SELECT id, content, 'mobius' AS table_name,
         1 - (embedding <=> query_embedding) AS similarity
  FROM memory_mobius
  WHERE user_id = user_id_param AND embedding IS NOT NULL

  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- ============================================================
-- STEP 3: Seed memory_mobius entries
-- ============================================================

INSERT INTO memory_mobius (id, user_id, content, tags, app_ids, file_refs, embedding, created_at, updated_at) VALUES
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius is a personal AI ecosystem: Mobius_Vercel (general assistant), Mobius_Coder (coding agent), Mobius_Factory (autonomous research crawler)', ARRAY['mobius','ecosystem','apps','overview'], ARRAY['Mobius_Vercel','Mobius_Coder','Mobius_Factory'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder URL: mobius-coder.vercel.app; GitHub: lotr2929/Mobius_Coder; path: C:\Users\263350F\_myProjects\Mobius\Mobius_Coder', ARRAY['coder','url','github','path'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder stack: vanilla JS frontend, Vercel serverless backend, Supabase (two projects: General DB for memory, Mobius Apps for sessions)', ARRAY['stack','vercel','supabase','js'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder cloud model stables: Google (Gemini Flash-Lite, Flash), Groq (Llama 3.3), Mistral (Codestral), Cerebras, OpenRouter, GitHub AI (GPT-4o)', ARRAY['models','ai','cloud','cascade'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder local AI via Ollama IPEX-LLM: qwen2.5-coder:7b for coding, qwen3.5:35b-a3b for general, deepseek-r1:7b for reasoning', ARRAY['ollama','local','qwen','deepseek'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Two-AI architecture: Brief AI (Gemini Flash) as director; Performance AIs by task: Codestral=code, Groq QwQ=debug, Gemini Flash=explain, Cerebras=plan', ARRAY['architecture','brief-ai','performance-ai','routing'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder commands: Memory: View/Add/Search/Distil/Delete/Embed/Import, Project: Open/Home/Read/Slim/Brief, Map:, All Mode, Ask: Qwen/DeepSeek/Ollama', ARRAY['commands','memory','project','modes'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder memory system: 5 Supabase tables -- memory_general (raw intake), memory_user, memory_tools, memory_project, memory_mobius (working set)', ARRAY['memory','tables','supabase','architecture'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder uses gemini-embedding-001 with outputDimensionality 768 for semantic memory search via pgvector cosine similarity', ARRAY['embedding','gemini','pgvector','semantic'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder All Mode sends query to all model stables and displays each response with model name underlined', ARRAY['all-mode','models','response','display'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder session chat logs written to chats/ folder as markdown files when Project: Home is set via FileSystem Access API', ARRAY['logging','chats','filesystem','session'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Project: Open loads _map.md, _slim.md, .brief from _context folder to give AI project context before queries', ARRAY['project','context','slim','brief'], ARRAY['Mobius_Coder'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Factory is an autonomous domain knowledge crawler: Gemini agrees research query, Tavily searches, findings reviewed, approved entries enter knowledge base', ARRAY['factory','crawler','research','tavily'], ARRAY['Mobius_Factory'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius General Supabase project holds all memory tables (GENERAL_SUPABASE_URL + GENERAL_SUPABASE_KEY); Mobius Apps Supabase holds sessions and conversations', ARRAY['supabase','database','env','keys'], ARRAY['Mobius_Coder','Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now());
