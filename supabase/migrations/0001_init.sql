-- ============================================================
-- OrbitAI — Schema inicial
-- Rode este arquivo no SQL Editor do Supabase (ou via CLI:
-- supabase db push). Idempotente: pode rodar mais de uma vez.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- profiles: dados públicos da conta + créditos
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  avatar_url  text,
  plan        text not null default 'free',
  credits     integer not null default 10000,
  created_at  timestamptz not null default now()
);

-- Cria profile automaticamente a cada signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- models: catálogo de modelos disponíveis na plataforma
-- ------------------------------------------------------------
create table if not exists public.models (
  id         text primary key,               -- id do provedor, ex: "meta-llama/llama-3.3-70b-instruct:free"
  name       text not null,
  provider   text not null default 'openrouter',
  icon       text not null default 'ph-sparkle',
  accent     text not null default 'text-app-accent',
  rate       numeric not null default 1,     -- créditos por 1k tokens (in+out)
  is_active  boolean not null default true,
  sort       int not null default 0
);

insert into public.models (id, name, provider, icon, accent, rate, sort) values
  ('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B · grátis',  'openrouter', 'ph-code',        'text-blue-400',   1, 1),
  ('google/gemini-2.0-flash-exp:free',       'Gemini 2.0 Flash · grátis','openrouter', 'ph-google-logo', 'text-sky-300',    1, 2),
  ('deepseek/deepseek-r1:free',              'DeepSeek R1 · grátis',    'openrouter', 'ph-brain',       'text-purple-400', 1, 3),
  ('qwen/qwen-2.5-72b-instruct:free',        'Qwen 2.5 72B · grátis',   'openrouter', 'ph-sparkle',     'text-amber-400',  1, 4),
  ('mistralai/mistral-7b-instruct:free',     'Mistral 7B · grátis',     'openrouter', 'ph-wind',        'text-teal-300',   1, 5)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- agents: agentes com system prompt próprio
-- ------------------------------------------------------------
create table if not exists public.agents (
  id            uuid primary key default uuid_generate_v4(),
  owner_id      uuid references auth.users(id) on delete cascade, -- null = agente da plataforma
  name          text not null,
  description   text not null default '',
  system_prompt text not null,
  model_id      text references public.models(id) on delete set null,
  icon          text not null default 'ph-robot',
  is_public     boolean not null default false,
  created_at    timestamptz not null default now()
);

insert into public.agents (owner_id, name, description, system_prompt, icon, is_public) values
  (null, 'Orbit', 'Assistente geral da plataforma',
   'Você é o Orbit, assistente de IA da plataforma OrbitAI. Responda sempre em português do Brasil, de forma clara, estruturada e útil. Use markdown com títulos, listas e blocos de código quando ajudar na clareza.',
   'ph-atom', true),
  (null, 'Devin', 'Engenheiro de software IA',
   'Você é o Devin, engenheiro de software sênior da plataforma OrbitAI. Responda em português do Brasil. Ajude com arquitetura, código, debugging e boas práticas. Sempre que possível inclua exemplos de código completos e executáveis em blocos markdown com a linguagem correta.',
   'ph-robot', true),
  (null, 'Clara', 'Redatora e revisora de conteúdo',
   'Você é a Clara, redatora e revisora da plataforma OrbitAI. Escreva e revise textos em português do Brasil com clareza, tom adequado ao público e gramática impecável. Ofereça variações de tom quando fizer sentido.',
   'ph-pen-nib', true),
  (null, 'Atlas', 'Analista de dados',
   'Você é o Atlas, analista de dados da plataforma OrbitAI. Responda em português do Brasil. Ajude a interpretar dados, montar queries SQL, planilhas, métricas e visualizações. Seja rigoroso com números e explique seu raciocínio.',
   'ph-chart-line-up', true)
on conflict do nothing;

-- ------------------------------------------------------------
-- conversations
-- ------------------------------------------------------------
create table if not exists public.conversations (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  agent_id    uuid references public.agents(id) on delete set null,
  title       text not null default 'Nova conversa',
  model_id    text references public.models(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);

-- ------------------------------------------------------------
-- messages
-- ------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         text not null,
  model           text,
  usage           jsonb,
  feedback        int not null default 0,
  attachments     jsonb not null default '[]',
  created_at      timestamptz not null default now()
);
create index if not exists messages_convo_idx on public.messages (conversation_id, created_at);

-- ------------------------------------------------------------
-- usage_events: consumo real de tokens (escrito só pelo backend)
-- ------------------------------------------------------------
create table if not exists public.usage_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  model           text,
  tokens_in       int not null default 0,
  tokens_out      int not null default 0,
  credits         numeric not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists usage_user_idx on public.usage_events (user_id, created_at);

-- ------------------------------------------------------------
-- shares: links públicos de conversa (read-only)
-- ------------------------------------------------------------
create table if not exists public.shares (
  slug            text primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles      enable row level security;
alter table public.models        enable row level security;
alter table public.agents        enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.usage_events  enable row level security;
alter table public.shares        enable row level security;

-- profiles: cada usuário vê/edita só o próprio
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (auth.uid() = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (auth.uid() = id);

-- models: catálogo público (share page precisa ler nomes)
drop policy if exists models_select on public.models;
create policy models_select on public.models for select to anon, authenticated using (true);

-- agents: vê os próprios + públicos; edita só os próprios
drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents for select using (is_public or auth.uid() = owner_id);
drop policy if exists agents_insert on public.agents;
create policy agents_insert on public.agents for insert with check (auth.uid() = owner_id);
drop policy if exists agents_update on public.agents;
create policy agents_update on public.agents for update using (auth.uid() = owner_id);
drop policy if exists agents_delete on public.agents;
create policy agents_delete on public.agents for delete using (auth.uid() = owner_id);

-- conversations: dono faz tudo; qualquer um lê se estiver compartilhada
drop policy if exists conv_select on public.conversations;
create policy conv_select on public.conversations for select to anon, authenticated
  using (auth.uid() = user_id or exists (select 1 from public.shares s where s.conversation_id = id));
drop policy if exists conv_insert on public.conversations;
create policy conv_insert on public.conversations for insert with check (auth.uid() = user_id);
drop policy if exists conv_update on public.conversations;
create policy conv_update on public.conversations for update using (auth.uid() = user_id);
drop policy if exists conv_delete on public.conversations;
create policy conv_delete on public.conversations for delete using (auth.uid() = user_id);

-- messages: dono da conversa faz tudo; leitura pública se a conversa foi compartilhada
drop policy if exists msg_select on public.messages;
create policy msg_select on public.messages for select to anon, authenticated
  using (
    exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
    or exists (select 1 from public.shares s where s.conversation_id = conversation_id)
  );
drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
drop policy if exists msg_update on public.messages;
create policy msg_update on public.messages for update
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
drop policy if exists msg_delete on public.messages;
create policy msg_delete on public.messages for delete
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- usage_events: usuário só lê o próprio; escrita apenas via service role (Edge Function)
drop policy if exists usage_select on public.usage_events;
create policy usage_select on public.usage_events for select using (auth.uid() = user_id);

-- shares: leitura pública por slug; criação/remoção só pelo dono
drop policy if exists shares_select on public.shares;
create policy shares_select on public.shares for select to anon, authenticated using (true);
drop policy if exists shares_insert on public.shares;
create policy shares_insert on public.shares for insert
  with check (auth.uid() = user_id and exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
drop policy if exists shares_delete on public.shares;
create policy shares_delete on public.shares for delete using (auth.uid() = user_id);

-- ============================================================
-- Storage: bucket privado para anexos
-- ============================================================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

drop policy if exists att_select on storage.objects;
create policy att_select on storage.objects for select
  using (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists att_insert on storage.objects;
create policy att_insert on storage.objects for insert
  with check (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists att_delete on storage.objects;
create policy att_delete on storage.objects for delete
  using (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
