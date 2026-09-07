-- OrbitAI core persistence. Apply with: supabase db push
create schema if not exists extensions;
create extension if not exists "pgcrypto";
create extension if not exists vector with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro','team','enterprise')),
  monthly_token_limit bigint not null default 100000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text not null default '',
  system_prompt text not null default 'Você é um assistente útil, preciso e seguro.',
  model text not null default '',
  provider text not null default 'openai-compatible',
  tools jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  is_public boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null default 'Nova conversa',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('system','user','assistant','tool')),
  content text not null,
  model text,
  provider text,
  usage jsonb not null default '{}'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null default 'Principal',
  provider text not null check (provider in ('openai-compatible','anthropic','openrouter','sglang')),
  base_url text not null default 'https://api.openai.com/v1',
  model text not null,
  encrypted_api_key text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, label)
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_microusd bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  mime_type text,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending','processing','ready','error')),
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id bigint generated always as identity primary key,
  file_id uuid not null references public.knowledge_files(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  content text not null,
  embedding extensions.vector(384),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversations_workspace_updated_idx on public.conversations(workspace_id, updated_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists usage_workspace_created_idx on public.usage_events(workspace_id, created_at desc);
create index if not exists knowledge_chunks_file_idx on public.knowledge_chunks(file_id);
create index if not exists knowledge_chunks_embedding_hnsw on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
      and role in ('owner','admin')
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.agents enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.provider_credentials enable row level security;
alter table public.usage_events enable row level security;
alter table public.knowledge_files enable row level security;
alter table public.knowledge_chunks enable row level security;

grant select, update on public.profiles to authenticated;
grant select on public.workspaces, public.workspace_members, public.agents, public.conversations, public.messages, public.usage_events, public.knowledge_files, public.knowledge_chunks to authenticated;
grant insert, update, delete on public.conversations, public.messages to authenticated;

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists workspaces_member_read on public.workspaces;
create policy workspaces_member_read on public.workspaces for select to authenticated using (public.is_workspace_member(id));

drop policy if exists workspace_members_member_read on public.workspace_members;
create policy workspace_members_member_read on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists agents_member_read on public.agents;
create policy agents_member_read on public.agents for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists agents_admin_write on public.agents;
create policy agents_admin_write on public.agents for all to authenticated using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));

drop policy if exists conversations_member_access on public.conversations;
create policy conversations_member_access on public.conversations for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists messages_member_access on public.messages;
create policy messages_member_access on public.messages for all to authenticated using (
  exists (select 1 from public.conversations c where c.id = conversation_id and public.is_workspace_member(c.workspace_id))
) with check (
  exists (select 1 from public.conversations c where c.id = conversation_id and public.is_workspace_member(c.workspace_id))
);

drop policy if exists usage_member_read on public.usage_events;
create policy usage_member_read on public.usage_events for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists files_member_access on public.knowledge_files;
create policy files_member_access on public.knowledge_files for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists chunks_member_read on public.knowledge_chunks;
create policy chunks_member_read on public.knowledge_chunks for select to authenticated using (public.is_workspace_member(workspace_id));

-- Credential ciphertext is intentionally server-only. Edge Functions use the service role.
revoke all on public.provider_credentials from anon, authenticated;
