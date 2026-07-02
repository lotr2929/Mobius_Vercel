-- Mobius semantic search migration
-- Run this once in Supabase SQL Editor (Mobius project)

-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Add embedding column (768-dim, matches Gemini text-embedding-004)
alter table mobius_docs
  add column if not exists embedding vector(768);

-- 3. Similarity search function (with relevance threshold)
create or replace function match_mobius_docs (
  query_embedding vector(768),
  match_count int default 5,
  match_threshold float default 0.5
)
returns table (
  id bigint,
  filename text,
  chunk text,
  similarity float
)
language sql stable
as $$
  select
    id,
    filename,
    chunk,
    1 - (embedding <=> query_embedding) as similarity
  from mobius_docs
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 4. Optional: index for faster search once you have many chunks
-- create index on mobius_docs using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ── Chat history semantic search ──────────────────────────────────────────

-- 5. Add embedding column to messages table
alter table mobius_messages
  add column if not exists embedding vector(768);

-- 6. Similarity search over chat history
create or replace function match_mobius_messages (
  query_embedding vector(768),
  match_count int default 8,
  match_threshold float default 0.5
)
returns table (
  id bigint,
  role text,
  content text,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    id,
    role,
    content,
    created_at,
    1 - (embedding <=> query_embedding) as similarity
  from mobius_messages
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
