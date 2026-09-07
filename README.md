# OrbitAI

OrbitAI is a multi-tenant AI workspace. The original repository was a static UI prototype; this branch adds the first production foundation without keeping LLM keys in the browser.

## What is real in this branch

- Supabase Auth-backed sessions.
- Workspace and membership bootstrap.
- Postgres schema with RLS for users, workspaces, agents, conversations, messages, usage and knowledge files.
- Encrypted provider credentials using AES-256-GCM in Edge Functions.
- Streaming chat through a server-side proxy.
- OpenAI-compatible providers: OpenAI, OpenRouter, SGLang/vLLM and other \`/chat/completions\` servers.
- Anthropic Messages streaming.
- Agent records with per-agent system prompts and model selection.
- No response simulation is used by the new backend path. If a provider is not configured, chat returns an explicit error.

## Setup

1. Create a Supabase project.
2. Enable the \`vector\` extension.
3. Apply the migration:

   \`\`\`bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   \`\`\`

4. Copy \`js/orbit-config.example.js\` to \`js/orbit-config.js\` and fill \`supabaseUrl\` and \`supabaseAnonKey\`.
5. Set Edge Function secrets:

   \`\`\`bash
   supabase secrets set ORBIT_ENCRYPTION_KEY="$(openssl rand -base64 32)"
   supabase secrets set ORBIT_PUBLIC_URL="https://your-domain.example"
   \`\`\`

   The deployed function also needs the standard \`SUPABASE_URL\`, \`SUPABASE_ANON_KEY\` and \`SUPABASE_SERVICE_ROLE_KEY\` values provided by Supabase.

6. Deploy functions:

   \`\`\`bash
   supabase functions deploy bootstrap
   supabase functions deploy providers
   supabase functions deploy agents
   supabase functions deploy chat
   \`\`\`

7. Serve the static site locally:

   \`\`\`bash
   python3 -m http.server 8080
   \`\`\`

The browser must use \`http://localhost\` or HTTPS. Do not open \`index.html\` directly with \`file://\`.

## Configure a provider

The provider endpoint is intentionally server-side. Store a credential using the \`providers\` function with a logged-in session:

- \`openai-compatible\`: base URL such as \`https://api.openai.com/v1\`
- \`openrouter\`: \`https://openrouter.ai/api/v1\`
- \`sglang\`: your reachable SGLang \`/v1\` endpoint; use \`local\` as the key when authentication is disabled
- \`anthropic\`: \`https://api.anthropic.com\`

The raw key is encrypted before it is persisted and is never returned by the API.

## Deployment recommendation

- Static frontend: Cloudflare Pages or Vercel.
- Auth/database/vector search: Supabase.
- Large files: Supabase Storage initially; migrate cold assets to Cloudflare R2 when volume justifies it.
- Long-running jobs: Cloudflare Queues/Workflows or a dedicated worker service.
- Self-hosted inference: SGLang on RunPod Serverless or a persistent GPU machine.

## Important limitation

This branch establishes the secure chat and agent foundation. File ingestion/RAG, MCP tool approval, voice, payments, background coding sandboxes and GitHub/Slack connectors are deliberately separate milestones; they require additional threat modeling and provider credentials rather than pretending to work in the UI.
