-- Mobius schema — memory tiers (PCM). Idempotent: safe to run more than once.
-- Run in the Supabase SQL Editor (shared "dlbs" project). Nothing here drops or rewrites existing data.
--
--   Tier 1  immediate   mobius_messages (last week) + mobius_memory kind 'week'
--   Tier 2  personal    mobius_memory kind 'profile'
--   Tier 3  current     mobius_memory kind 'project'
--   Tier 4  archive     mobius_messages + mobius_docs + mobius_docs_full (everything)
--
-- If the app uses the anon key and Row Level Security is switched on for new tables,
-- the new tables need a policy (or use the service-role key), as the existing mobius_ tables do.

create extension if not exists vector;

-- ── Archive tables (already exist in the live project; created here for a fresh database) ──
create table if not exists mobius_messages (
  id                 bigserial primary key,
  role               text not null check (role in ('user','assistant')),
  content            text not null,
  ai_provider        text,
  docs               jsonb,
  embedding          vector(1024),
  embedding_provider text,
  created_at         timestamptz default now()
);
alter table mobius_messages add column if not exists embedding vector(1024);
alter table mobius_messages add column if not exists embedding_provider text;
alter table mobius_messages add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;
create index if not exists mobius_messages_created_at on mobius_messages (created_at desc);
create index if not exists mobius_messages_fts on mobius_messages using gin (fts);

create table if not exists mobius_docs (
  id                 bigserial primary key,
  filename           text not null,
  chunk              text not null,
  source             text default 'upload',
  modified_at        text,
  embedding          vector(1024),
  embedding_provider text,
  created_at         timestamptz default now()
);
alter table mobius_docs add column if not exists embedding vector(1024);
alter table mobius_docs add column if not exists embedding_provider text;
alter table mobius_docs add column if not exists fts tsvector
  generated always as (to_tsvector('english', chunk)) stored;
create index if not exists mobius_docs_filename on mobius_docs (filename);
create index if not exists mobius_docs_fts on mobius_docs using gin (fts);

create table if not exists mobius_docs_full (
  filename   text primary key,
  content    text,
  updated_at timestamptz default now()
);

-- Optional once the archive grows (thousands of vectors): approximate-nearest-neighbour indexes.
-- create index if not exists mobius_messages_embedding on mobius_messages using hnsw (embedding vector_cosine_ops);
-- create index if not exists mobius_docs_embedding     on mobius_docs     using hnsw (embedding vector_cosine_ops);

-- ── Curated memory (tiers 1–3) ───────────────────────────────────────────────
create table if not exists mobius_memory (
  id         bigserial primary key,
  kind       text not null check (kind in ('profile','project','week')),
  key        text not null default 'main',          -- 'main' for profile/week, the project name for projects
  content    text not null,
  keywords   text[] not null default '{}',
  status     text not null default 'active' check (status in ('active','proposed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mobius_memory_one_active on mobius_memory (kind, key) where status = 'active';
create index if not exists mobius_memory_lookup on mobius_memory (kind, status, key);

-- Job cursors: where each maintenance job got to.
create table if not exists mobius_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- Passkeys registered for login (fingerprint / Windows Hello). Row Level Security is on with no
-- policies: only the server's secret key can read or write these.
create table if not exists mobius_passkeys (
  id          text primary key,          -- credential id (base64url)
  public_key  text not null,             -- base64url
  counter     bigint not null default 0,
  transports  text[],
  device_name text,
  created_at  timestamptz not null default now(),
  last_used   timestamptz
);
alter table mobius_passkeys enable row level security;

-- Flight recorder: one row per chat turn / browser error, deleted after 14 days. Holds full
-- prompts (personal memory included), so Row Level Security is on with no policies.
create table if not exists mobius_traces (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  kind       text not null,           -- 'chat' | 'client'
  data       jsonb not null
);
create index if not exists mobius_traces_created on mobius_traces (created_at desc);
alter table mobius_traces enable row level security;

-- Notes: things Boon asked Mobius to remember ("Remember that ..."), plus suggestions the review
-- job found in his conversations, which wait for his say-so. Always sent to the model while active.
create table if not exists mobius_notes (
  id         bigserial primary key,
  content    text not null,
  source     text not null default 'asked',     -- 'asked' | 'suggested'
  status     text not null default 'active',    -- 'active' | 'proposed' | 'forgotten' | 'rejected'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mobius_notes_status on mobius_notes (status, created_at desc);
alter table mobius_notes enable row level security;

-- Trash: whatever Mobius removes (a deleted document, a pruned older version, a stale note) lands
-- here first, with everything needed to restore it, and is mirrored to the laptop's Backup folder
-- whenever Mobius runs there. Cleared out after 180 days.
create table if not exists mobius_trash (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,          -- 'document' | 'note' | 'memory'
  label       text not null,
  reason      text,
  payload     jsonb not null,         -- everything needed to restore it
  mirrored    boolean not null default false,   -- already written to the laptop Backup folder
  restored_at timestamptz
);
create index if not exists mobius_trash_created on mobius_trash (created_at desc);
alter table mobius_trash enable row level security;

-- Development notes: Boon's to-do list of instructions and improvements, typed in Settings from any
-- device, to be worked through in the next session at the laptop. Not sent to any AI model.
create table if not exists mobius_devnotes (
  id         bigserial primary key,
  content    text not null,
  status     text not null default 'open',     -- 'open' | 'done'
  result     text,                              -- what was done about it, filled in when it is marked done
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists mobius_devnotes_status on mobius_devnotes (status, created_at);
alter table mobius_devnotes enable row level security;

-- Linked folders: cloud folders Boon links in Settings by pasting a share link. Google Drive folders
-- are read and indexed (newest files first, up to max_files); other providers are only recorded.
create table if not exists mobius_sources (
  id            bigserial primary key,
  provider      text not null default 'gdrive',
  url           text not null,
  external_id   text,
  resource_key  text,
  label         text not null,
  is_folder     boolean not null default true,
  max_files     integer not null default 200,
  status        text not null default 'pending',   -- 'ok' | 'pending' | 'no_access' | 'unsupported' | 'paused' | 'error'
  detail        text,
  files_seen    integer,
  files_indexed integer,
  last_checked  timestamptz,
  last_synced   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists mobius_sources_status on mobius_sources (status, id);
alter table mobius_sources enable row level security;
alter table mobius_sources add column if not exists access text not null default 'service';  -- 'user' = Boon's Google account, 'service' = the service account

-- The connected Google account (one row). Lets Mobius read Boon's Drive as himself, read-only, so folders
-- need no sharing. The client secret and refresh token are sealed (AES-256-GCM keyed from SESSION_SECRET).
create table if not exists mobius_google (
  id             integer primary key default 1 check (id = 1),
  client_id      text,
  client_secret  text,
  refresh_token  text,
  email          text,
  scope          text,
  oauth_state    text,
  oauth_state_at timestamptz,
  connected_at   timestamptz,
  last_error     text,
  updated_at     timestamptz not null default now()
);
alter table mobius_google enable row level security;

-- Conversations: the message log cut into chats (a new chat begins after 20 minutes of silence), each with a title and
-- summary, so that Boon can refer to "that chat" and Mobius can find and read it.
create table if not exists mobius_chats (
  id               bigserial primary key,
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  first_message_id bigint,
  last_message_id  bigint,
  message_count    integer not null default 0,
  title            text,
  summary          text,
  summary_msgs     integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists mobius_chats_started on mobius_chats (started_at desc);
alter table mobius_chats enable row level security;
alter table mobius_messages add column if not exists chat_id bigint;
create index if not exists mobius_messages_chat on mobius_messages (chat_id);

-- Pictures sent in chat. The (shrunk) image itself is kept in the private Storage bucket "mobius-attachments", so a later
-- "the man in the previous image" can be answered by looking at it again.
create table if not exists mobius_attachments (
  id         bigserial primary key,
  message_id bigint,
  kind       text not null default 'image',
  path       text not null,
  mime       text,
  bytes      integer,
  caption    text,
  created_at timestamptz not null default now()
);
create index if not exists mobius_attachments_message on mobius_attachments (message_id);
create index if not exists mobius_attachments_created on mobius_attachments (created_at desc);
alter table mobius_attachments enable row level security;
insert into storage.buckets (id, name, public) values ('mobius-attachments', 'mobius-attachments', false) on conflict (id) do nothing;

-- Public-domain Bible texts, one row per verse, looked up by reference (backend/bible.js). Loaded once from the scrollmapper
-- bible_databases KJV.csv and the TehShrike world-english-bible JSON files (31,102 KJV and 31,098 WEB verses).
create table if not exists mobius_bible (
  translation text     not null,   -- 'WEB' or 'KJV'
  book        smallint not null,   -- 1 (Genesis) to 66 (Revelation)
  chapter     smallint not null,
  verse       smallint not null,
  text        text     not null,
  primary key (translation, book, chapter, verse)
);
alter table mobius_bible enable row level security;

-- Sizes for the Settings page (the free plan allows 500 MB for the whole project).
create or replace function pcm_storage ()
returns table (name text, bytes bigint)
language sql stable
as $$
  select * from (
    select 'database'::text as name, pg_database_size(current_database())::bigint as bytes
    union all
    select tablename::text, pg_total_relation_size(quote_ident(tablename)::regclass)::bigint
      from pg_tables where schemaname = 'public' and tablename like 'mobius%'
  ) s order by bytes desc;
$$;

-- ── Memory functions ─────────────────────────────────────────────────────────

-- Replace the row of this status for (kind, key); the old one is archived, and only the
-- five newest archived versions are kept.
create or replace function pcm_put_memory (
  p_kind text, p_key text, p_content text, p_keywords text[], p_status text
) returns bigint
language plpgsql
as $$
declare
  new_id bigint;
begin
  update mobius_memory set status = 'archived', updated_at = now()
   where kind = p_kind and key = p_key and status = p_status;

  insert into mobius_memory (kind, key, content, keywords, status)
  values (p_kind, p_key, p_content, coalesce(p_keywords, '{}'), p_status)
  returning id into new_id;

  -- keep the five newest archived versions; older ones go to the trash, not oblivion
  with doomed as (
    select id, kind, key, content, created_at from mobius_memory
     where kind = p_kind and key = p_key and status = 'archived'
     order by created_at desc, id desc offset 5
  ), moved as (
    insert into mobius_trash (kind, label, reason, payload)
    select 'memory', kind || ' / ' || key, 'older version pruned',
           jsonb_build_object('kind', kind, 'key', key, 'content', content, 'created_at', created_at)
      from doomed
  )
  delete from mobius_memory where id in (select id from doomed);
  return new_id;
end;
$$;

-- Approve a proposal: the newest 'proposed' row becomes active, the old active row is archived.
create or replace function pcm_promote_memory (p_kind text, p_key text)
returns bigint
language plpgsql
as $$
declare
  pid bigint;
begin
  select id into pid from mobius_memory
   where kind = p_kind and key = p_key and status = 'proposed'
   order by created_at desc, id desc limit 1;
  if pid is null then return null; end if;

  update mobius_memory set status = 'archived', updated_at = now()
   where kind = p_kind and key = p_key and status = 'active';
  update mobius_memory set status = 'active', updated_at = now() where id = pid;
  return pid;
end;
$$;

-- ── Archive search: vector rank and keyword rank fused (reciprocal rank fusion) ──
-- Without an embedding (query_embedding null) only the keyword half runs.
-- Messages get a mild recency boost (about a 90-day half-life).

create or replace function pcm_search_messages (
  query_text      text,
  query_embedding vector(1024) default null,
  match_count     int          default 6,
  min_date        timestamptz  default null,
  min_similarity  float        default 0.5
)
returns table (id bigint, role text, content text, created_at timestamptz, score float)
language sql stable
as $$
  with sem as (
    select m.id, row_number() over (order by m.embedding <=> query_embedding) as rnk
    from mobius_messages m
    where query_embedding is not null
      and m.embedding is not null
      and 1 - (m.embedding <=> query_embedding) >= min_similarity
      and (min_date is null or m.created_at >= min_date)
    order by m.embedding <=> query_embedding
    limit match_count * 4
  ),
  kw as (
    select m.id, row_number() over (order by ts_rank(m.fts, q.tsq) desc) as rnk
    from mobius_messages m,
         (select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq) q
    where coalesce(query_text, '') <> ''
      and m.fts @@ q.tsq
      and (min_date is null or m.created_at >= min_date)
    order by ts_rank(m.fts, q.tsq) desc
    limit match_count * 4
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0 / (60 + sem.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0) as rrf
    from sem full outer join kw on sem.id = kw.id
  )
  select m.id, m.role, m.content, m.created_at,
         (f.rrf * (1 + 0.3 * exp(-extract(epoch from (now() - m.created_at)) / 86400.0 / 90.0)))::float as score
  from fused f
  join mobius_messages m on m.id = f.id
  order by 5 desc
  limit match_count;
$$;

create or replace function pcm_search_docs (
  query_text      text,
  query_embedding vector(1024) default null,
  match_count     int          default 5,
  min_similarity  float        default 0.5
)
returns table (id bigint, filename text, chunk text, score float)
language sql stable
as $$
  with sem as (
    select d.id, row_number() over (order by d.embedding <=> query_embedding) as rnk
    from mobius_docs d
    where query_embedding is not null
      and d.embedding is not null
      and 1 - (d.embedding <=> query_embedding) >= min_similarity
    order by d.embedding <=> query_embedding
    limit match_count * 4
  ),
  kw as (
    select d.id, row_number() over (order by ts_rank(d.fts, q.tsq) desc) as rnk
    from mobius_docs d,
         (select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq) q
    where coalesce(query_text, '') <> ''
      and d.fts @@ q.tsq
    order by ts_rank(d.fts, q.tsq) desc
    limit match_count * 4
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0 / (60 + sem.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0) as rrf
    from sem full outer join kw on sem.id = kw.id
  )
  select d.id, d.filename, d.chunk, f.rrf::float as score
  from fused f
  join mobius_docs d on d.id = f.id
  order by 4 desc
  limit match_count;
$$;

-- Per-file chunk counts for the document list (a plain select would hit the 1,000-row API limit).
create or replace function pcm_doc_stats ()
returns table (filename text, total bigint, embedded bigint)
language sql stable
as $$
  select filename, count(*), count(embedding) from mobius_docs group by filename;
$$;

-- Which files have chunks, and where they came from (used to spot files removed from Drive).
create or replace function pcm_doc_sources ()
returns table (filename text, source text)
language sql stable
as $$
  select distinct filename, source from mobius_docs;
$$;

-- The old match_mobius_docs / match_mobius_messages functions and the mobius_topics table
-- are no longer used by the app. They are left in place; drop them whenever convenient.
