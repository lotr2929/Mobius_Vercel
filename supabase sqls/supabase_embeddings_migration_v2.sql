-- Mobius semantic search migration — v2 (1024-dim, supports Gemini+Mistral cascade)
-- Run this once in Supabase SQL Editor (Mobius project)
-- NOTE: this replaces the old 768-dim columns. Existing embeddings will be wiped
-- and must be re-backfilled (one-time, last time).

-- 1. Enable pgvector extension
create extension if not exists vector;

-- ── mobius_docs ──────────────────────────────────────────────────────────────

-- 2. Drop old 768-dim column and function, add new 1024-dim column
alter table mobius_docs drop column if exists embedding;
alter table mobius_docs add column embedding vector(1024);

drop function if exists match_mobius_docs(vector(768), int, float);
drop function if exists match_mobius_docs(vector(768), int);

create or replace function match_mobius_docs (
  query_embedding vector(1024),
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

-- 3. Optional: index for faster search once you have many chunks
-- create index on mobius_docs using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ── mobius_messages ────────────────────────────────────────────────────────

-- 4. Drop old 768-dim column and function, add new 1024-dim column
alter table mobius_messages drop column if exists embedding;
alter table mobius_messages add column embedding vector(1024);

drop function if exists match_mobius_messages(vector(768), int, float);
drop function if exists match_mobius_messages(vector(768), int);

create or replace function match_mobius_messages (
  query_embedding vector(1024),
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
