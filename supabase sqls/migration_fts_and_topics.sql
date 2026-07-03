-- Run in Supabase SQL Editor (dlbs / Mobius project)
-- Paste and run both blocks together.

-- 1. Keyword search for chat messages (mobius_docs already has this)
alter table mobius_messages add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;
create index if not exists mobius_messages_fts on mobius_messages using gin(fts);

-- 2. Topic index — RAKE-extracted keywords per chunk/message, book-index style
create table if not exists mobius_topics (
  id           bigserial primary key,
  term         text not null,
  score        float,
  source_table text not null,   -- 'mobius_docs' or 'mobius_messages'
  source_id    bigint not null, -- the chunk/message id it came from
  filename     text,            -- null for chat messages
  created_at   timestamptz default now()
);
create index if not exists mobius_topics_term on mobius_topics(term);
create index if not exists mobius_topics_source on mobius_topics(source_table, source_id);
