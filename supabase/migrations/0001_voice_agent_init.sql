-- JETZT Voice Agent — initial schema.
-- Tables here are new and specific to the AI voice agent. The "business
-- data" tool is expected to read/write the dialer's existing `leads` /
-- `calls` tables instead (see docs/voice-agent-plan.md) — those aren't
-- created here since their exact schema lives with the dialer app, not
-- this repo.

create extension if not exists vector;

-- Admin portal allowlist: Google OAuth restricted to these emails
-- (app-level check, not a Workspace-domain restriction — see
-- docs/voice-agent-plan.md "Admin portal").
create table if not exists admins (
  email text primary key,
  created_at timestamptz not null default now()
);

-- Core instructions + timely info: small, always-injected-into-every-call
-- config, edited from the admin portal. One row per key.
create table if not exists agent_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
insert into agent_config (key, value) values
  ('core_instructions', ''),
  ('timely_info', '')
on conflict (key) do nothing;

-- Knowledge base for RAG — larger reference material (FAQs, policies,
-- product info), embedded with OpenAI text-embedding-3-small (1536 dims).
create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536) not null,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_base_embedding_idx
  on knowledge_base using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_knowledge_base(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (id uuid, content text, source text, similarity float)
language sql stable
as $$
  select
    id,
    content,
    source,
    1 - (embedding <=> query_embedding) as similarity
  from knowledge_base
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Per-caller memory — facts recognized by phone number, auto-applied
-- (lowest tier of the memory/learning policy).
create table if not exists caller_memory (
  phone_number text primary key,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

-- Review queue for medium/high-risk learning tiers — additive KB facts
-- (auto-applied, logged here for visibility/revert) and core-instruction
-- changes (held here until an admin approves).
create table if not exists insights (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('kb_fact', 'instruction_change')),
  content text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'auto_applied')),
  source_call_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One row per inbound AI-agent call — transcript, recording, outcome.
-- Shown per phone number in the admin portal's call history.
create table if not exists voice_agent_calls (
  id uuid primary key default gen_random_uuid(),
  call_control_id text unique not null,
  caller_phone text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript jsonb not null default '[]',
  recording_url text,
  outcome text,
  created_at timestamptz not null default now()
);
create index if not exists voice_agent_calls_caller_phone_idx
  on voice_agent_calls (caller_phone);

-- Tracks what a caller booked via Calendly, so a later call can find "their"
-- meeting to cancel or reschedule without the caller knowing any Calendly
-- ids themselves. v1 assumes one active booking per caller phone number.
create table if not exists calendly_bookings (
  id uuid primary key default gen_random_uuid(),
  caller_phone text not null,
  event_uuid text not null,
  invitee_name text,
  invitee_email text,
  scheduled_time timestamptz,
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists calendly_bookings_caller_phone_idx
  on calendly_bookings (caller_phone);

-- Messages taken by the fallback tool when the agent can't resolve
-- something on its own — caller's email is captured via the
-- confirm-by-spelling flow before being stored here.
create table if not exists fallback_messages (
  id uuid primary key default gen_random_uuid(),
  call_control_id text,
  caller_phone text,
  message text not null,
  contact_email text not null,
  status text not null default 'open' check (status in ('open', 'responded')),
  created_at timestamptz not null default now()
);

-- Every table above holds caller-identifying data (emails, transcripts,
-- recordings) or admin-only config, so RLS is on everywhere with no
-- policies defined yet — deny-all for the anon/authenticated roles. The
-- voice backend only ever connects with SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS regardless, so this doesn't affect it. Add scoped policies
-- once the admin portal's actual access pattern (server route vs. direct
-- client-side Supabase queries) is decided, rather than guessing now.
alter table admins enable row level security;
alter table agent_config enable row level security;
alter table knowledge_base enable row level security;
alter table caller_memory enable row level security;
alter table insights enable row level security;
alter table voice_agent_calls enable row level security;
alter table calendly_bookings enable row level security;
alter table fallback_messages enable row level security;
