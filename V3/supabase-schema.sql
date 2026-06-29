-- ============================================================
--  SCHOLARLY REPOSITORY — Supabase Schema
--  Paste this entire block into the Supabase SQL Editor
--  and click "Run". It is safe to re-run (uses IF NOT EXISTS).
-- ============================================================

-- ── Enable UUID extension ──────────────────────────────────
create extension if not exists "uuid-ossp";

-- ══════════════════════════════════════════════════════════
--  TABLE: profiles
--  One row per registered author. Linked to auth.users via id.
-- ══════════════════════════════════════════════════════════
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text        not null,
  college_id    text        not null unique,
  department    text        not null default 'BCA',
  institution   text        not null default 'XYZ College',
  bio           text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Auto-update updated_at on every row change
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.handle_updated_at();

-- Row-Level Security: authors can only edit their own profile
alter table public.profiles enable row level security;

drop policy if exists "Public profiles are viewable by everyone" on public.profiles;
create policy "Public profiles are viewable by everyone"
  on public.profiles for select using (true);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = id);


-- ══════════════════════════════════════════════════════════
--  TABLE: papers
--  One row per uploaded research paper or case study.
-- ══════════════════════════════════════════════════════════
create table if not exists public.papers (
  id              uuid        primary key default uuid_generate_v4(),
  author_id       uuid        not null references public.profiles(id) on delete cascade,
  title           text        not null,
  paper_type      text        not null check (paper_type in ('Research Paper', 'Case Study')),
  abstract        text,
  keywords        text[],               -- e.g. ARRAY['AI','Education','India']
  published_date  date,
  html_content    text,                 -- compiled HTML from mammoth
  docx_url        text,                 -- Supabase Storage public URL for .docx download
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists papers_updated_at on public.papers;
create trigger papers_updated_at
  before update on public.papers
  for each row execute procedure public.handle_updated_at();

-- Row-Level Security
alter table public.papers enable row level security;

drop policy if exists "Papers are publicly readable" on public.papers;
create policy "Papers are publicly readable"
  on public.papers for select using (true);

drop policy if exists "Authors can insert their own papers" on public.papers;
create policy "Authors can insert their own papers"
  on public.papers for insert with check (auth.uid() = author_id);

drop policy if exists "Authors can update their own papers" on public.papers;
create policy "Authors can update their own papers"
  on public.papers for update using (auth.uid() = author_id);

drop policy if exists "Authors can delete their own papers" on public.papers;
create policy "Authors can delete their own papers"
  on public.papers for delete using (auth.uid() = author_id);


-- ══════════════════════════════════════════════════════════
--  TABLE: ratings
--  Stores 1-5 star ratings. One rating per user per paper.
-- ══════════════════════════════════════════════════════════
create table if not exists public.ratings (
  id         uuid        primary key default uuid_generate_v4(),
  paper_id   uuid        not null references public.papers(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  stars      smallint    not null check (stars >= 1 and stars <= 5),
  created_at timestamptz not null default now(),
  unique (paper_id, user_id)   -- one rating per user per paper
);

alter table public.ratings enable row level security;

drop policy if exists "Ratings are publicly readable" on public.ratings;
create policy "Ratings are publicly readable"
  on public.ratings for select using (true);

drop policy if exists "Logged-in users can rate" on public.ratings;
create policy "Logged-in users can rate"
  on public.ratings for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own rating" on public.ratings;
create policy "Users can update their own rating"
  on public.ratings for update using (auth.uid() = user_id);


-- ══════════════════════════════════════════════════════════
--  VIEW: paper_stats   (average rating + count, per paper)
-- ══════════════════════════════════════════════════════════
create or replace view public.paper_stats as
  select
    p.id            as paper_id,
    p.title,
    p.author_id,
    coalesce(round(avg(r.stars)::numeric, 1), 0) as avg_rating,
    count(r.id)                                   as rating_count
  from public.papers p
  left join public.ratings r on r.paper_id = p.id
  group by p.id;


-- ══════════════════════════════════════════════════════════
--  STORAGE BUCKET: paper-assets
--  Stores: extracted images from .docx files + the .docx files themselves
-- ══════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('paper-assets', 'paper-assets', true)
on conflict (id) do nothing;

drop policy if exists "Anyone can read paper assets" on storage.objects;
create policy "Anyone can read paper assets"
  on storage.objects for select
  using (bucket_id = 'paper-assets');

drop policy if exists "Authenticated users can upload paper assets" on storage.objects;
create policy "Authenticated users can upload paper assets"
  on storage.objects for insert
  with check (bucket_id = 'paper-assets' and auth.role() = 'authenticated');

drop policy if exists "Authenticated users can update their assets" on storage.objects;
create policy "Authenticated users can update their assets"
  on storage.objects for update
  using (bucket_id = 'paper-assets' and auth.uid()::text = (storage.foldername(name))[1]);


-- ============================================================
--  MIGRATION v2 → v3 — Simplified Upload System
--  Run this block in the Supabase SQL editor after the
--  original schema is already applied.
-- ============================================================

-- Add thumbnail_url column (stores public URL from storage)
alter table public.papers
  add column if not exists thumbnail_url text;

-- Add doc_url column (the uploaded PDF/DOCX/DOC download link)
alter table public.papers
  add column if not exists doc_url text;

-- Note: abstract column already exists and is reused for the summary.
-- Note: docx_url column already exists and is set to the same value
--       as doc_url for backward compatibility with paper.html.


-- ============================================================
--  FIX: Auto-create profile row on every new signup
--  This prevents the 401 "Author profile not found" error that
--  occurs when a user signs up but their profiles row doesn't
--  exist yet at upload time.
--
--  Run this block in the Supabase SQL editor (safe to re-run).
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, college_id, department, institution)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'college_id', new.id::text),
    coalesce(new.raw_user_meta_data->>'department',  'General'),
    coalesce(new.raw_user_meta_data->>'institution', 'Unknown Institution')
  )
  on conflict (id) do nothing;   -- safe to re-fire
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ============================================================
--  MIGRATION v3 → v4 — Full-Text Search Indexes
--  Additive only. Run in Supabase SQL editor (safe to re-run).
--
--  NOTE: We intentionally do NOT use a generated tsvector column
--  because Postgres requires generation expressions to be
--  immutable, and to_tsvector('english', ...) is only stable,
--  not immutable — causing ERROR 42P17 on Supabase.
--
--  Instead we use expression indexes, which Postgres evaluates
--  at index-build/update time and does not subject to the same
--  immutability check. The homepage search works fully
--  client-side via JS; these indexes speed up any future
--  server-side search queries on large datasets.
-- ============================================================

-- Expression index: full-text search across title + abstract + keywords
-- Uses 'simple' config (strips accents/stopwords) which IS immutable.
create index if not exists papers_fts_idx
  on public.papers
  using gin(
    to_tsvector('simple',
      coalesce(title, '') || ' ' ||
      coalesce(abstract, '') || ' ' ||
      coalesce(array_to_string(keywords, ' '), '')
    )
  );

-- Expression index on title only (for fast title-only searches)
create index if not exists papers_title_fts_idx
  on public.papers
  using gin(to_tsvector('simple', coalesce(title, '')));

-- B-tree index on author_id + created_at (homepage load order, author page)
create index if not exists papers_author_created_idx
  on public.papers(author_id, created_at desc);
