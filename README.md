# OrbitAI — Plataforma de Agentes de IA

Plataforma completa de chat com agentes de IA: autenticação real, conversas persistidas, streaming de respostas, catálogo de agentes com system prompts customizáveis, anexos, ditado por voz, compartilhamento público e controle de créditos — tudo em infraestrutura **gratuita**.

## Arquitetura

```
Browser (frontend estático)
   └─► Cloudflare Pages / Vercel — hosting grátis
         └─► Supabase (free tier)
               ├─ Auth (e-mail + Google OAuth)
               ├─ Postgres (conversas, mensagens, agentes, uso)
               ├─ Storage (anexos)
               └─ Edge Function `chat` — proxy de IA com streaming
                     └─► OpenRouter / Groq / qualquer API OpenAI-compatible
```

**Custo estimado: R$0/mês** nos free tiers (Supabase + Cloudflare Pages + modelos `:free` do OpenRouter).

## Estrutura

```
frontend/            # app web (vanilla JS, sem build)
  index.html         # app principal (requer login)
  login.html         # autenticação
  share.html         # página pública de conversa compartilhada
  js/config.js       # ← EDITE com suas credenciais Supabase
  js/db.js           # camada de dados
  js/app.js          # UI + lógica do chat
supabase/
  migrations/0001_init.sql   # schema + RLS + seeds
  functions/chat/index.ts    # proxy de IA (Deno)
  config.toml
```

## Setup passo a passo (~15 min)

### 1. Criar projeto Supabase (grátis)

1. Acesse [supabase.com](https://supabase.com) → **New project** (free tier).
2. Anote a **Project URL** e a **anon public key** em *Project Settings → API*.

### 2. Rodar a migration

No dashboard: **SQL Editor → New query** → cole todo o conteúdo de `supabase/migrations/0001_init.sql` → **Run**.

Isso cria: `profiles`, `models` (com modelos grátis), `agents` (4 agentes seed), `conversations`, `messages`, `usage_events`, `shares`, RLS e o bucket `attachments`.

### 3. Deploy da Edge Function

Opção A — CLI:
```bash
npm i -g supabase
supabase login
supabase link --project-ref SEU-PROJECT-REF
supabase functions deploy chat
```

Opção B — Dashboard: **Edge Functions → New function** → nome `chat` → cole `supabase/functions/chat/index.ts` → Deploy.

### 4. Configurar secrets da função

```bash
supabase secrets set AI_API_KEY=sk-or-SUA-CHAVE-OPENROUTER
```

Ou no dashboard: **Edge Functions → chat → Settings → Secrets**.

- **OpenRouter** (recomendado): crie a chave grátis em [openrouter.ai/keys](https://openrouter.ai/keys). Os modelos `:free` do seed não cobram nada.
- Alternativas: Groq (`AI_BASE_URL=https://api.groq.com/openai/v1`), OpenAI, Together — qualquer endpoint `/chat/completions`.

### 5. Configurar o frontend

Edite `frontend/js/config.js`:

```js
window.ORBIT_CONFIG = {
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
  SUPABASE_ANON_KEY: 'sua-anon-key',
};
```

### 6. Rodar localmente

```bash
cd frontend
npx serve .        # ou: python -m http.server 8080
```

Abra `http://localhost:3000` → crie sua conta → converse.

### 7. Deploy do frontend (grátis)

**Cloudflare Pages** (recomendado):
1. [pages.cloudflare.com](https://pages.cloudflare.com) → **Connect to Git** → selecione `Orbit-AI`.
2. Build settings: framework **None**, build command vazio, output dir = `frontend`.
3. Deploy → URL `https://orbit-ai.pages.dev`.

**Alternativas**: Vercel (root dir = `frontend`), Netlify, GitHub Pages.

### 8. Google OAuth (opcional)

1. Supabase → **Authentication → Providers → Google** → ative e configure Client ID/Secret (Google Cloud Console).
2. Adicione a URL do site em **Authentication → URL Configuration → Site URL**.

## Funcionalidades

- **Auth real** — e-mail/senha + Google, sessões, perfil automático
- **Chat com streaming** — SSE via Edge Function, respostas token a token
- **Multi-modelo** — catálogo no banco (`models`), modelos grátis do OpenRouter
- **Agentes** — 4 seeds (Orbit, Devin, Clara, Atlas) + criação/edição de agentes com system prompt próprio
- **Anexos** — arquivos de texto entram no contexto; imagens vão como visão (modelos multimodais)
- **Voz** — ditado via Web Speech API (pt-BR)
- **Compartilhamento** — link público read-only (`share.html?s=…`)
- **Créditos reais** — débito por tokens usados, painel de uso alimentado por `usage_events`
- **Exportar** — conversa em .md, backup completo em .json
- **Segurança** — RLS em todas as tabelas; API keys nunca saem do servidor

## Roadmap (próximas fases)

- Billing: Stripe/Mercado Pago + pacotes de créditos
- Busca web (Tavily/Brave free tier) como tool
- Sandbox de código estilo Devin (E2B/Daytona)
- Título de conversa gerado por IA
- Renovação automática de créditos por ciclo (cron no Supabase)
