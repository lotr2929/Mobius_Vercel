-- Mobius Supabase schema
-- Run once in Supabase SQL editor

-- Chat history
create table if not exists mobius_messages (
  id          bigserial primary key,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  ai_provider text,
  created_at  timestamptz default now()
);
create index if not exists mobius_messages_created_at on mobius_messages(created_at desc);

-- Document chunks
create table if not exists mobius_docs (
  id          bigserial primary key,
  filename    text not null,
  chunk       text not null,
  source      text default 'upload',
  modified_at text,
  created_at  timestamptz default now()
);
create index if not exists mobius_docs_filename on mobius_docs(filename);
create index if not exists mobius_docs_source on mobius_docs(source);

-- Full text search on documents
alter table mobius_docs add column if not exists fts tsvector
  generated always as (to_tsvector('english', chunk)) stored;
create index if not exists mobius_docs_fts on mobius_docs using gin(fts);
