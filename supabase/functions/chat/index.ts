// ============================================================
// OrbitAI — Edge Function: chat
// Proxy de streaming para provedores OpenAI-compatible
// (OpenRouter por padrão). Valida JWT, verifica créditos,
// grava mensagens e uso no Postgres via service role.
//
// Secrets necessários (supabase secrets set):
//   AI_API_KEY      — chave do provedor (ex: sk-or-...)
// Opcionais:
//   AI_BASE_URL     — default https://openrouter.ai/api/v1
//   AI_DEFAULT_MODEL— default meta-llama/llama-3.3-70b-instruct:free
//   APP_URL         — usado no header HTTP-Referer do OpenRouter
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AI_BASE_URL = (Deno.env.get('AI_BASE_URL') ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const AI_API_KEY = Deno.env.get('AI_API_KEY') ?? '';
const DEFAULT_MODEL = Deno.env.get('AI_DEFAULT_MODEL') ?? 'meta-llama/llama-3.3-70b-instruct:free';
const APP_URL = Deno.env.get('APP_URL') ?? 'https://orbit-ai.pages.dev';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_SYSTEM =
  'Você é o Orbit, assistente de IA da plataforma OrbitAI. Responda sempre em português do Brasil, de forma clara, estruturada e útil. Use markdown quando ajudar na clareza.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function sseEvent(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!AI_API_KEY) return json({ error: 'AI_API_KEY não configurada no servidor.' }, 500);

  // ---- Auth: valida o JWT do usuário ----
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Não autenticado.' }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: 'Sessão inválida ou expirada.' }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Payload ----
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const content: string = (body.content ?? '').toString().slice(0, 32000);
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 8) : [];
  if (!content.trim() && !attachments.length) return json({ error: 'Mensagem vazia.' }, 400);

  // ---- Créditos ----
  const { data: profile } = await admin.from('profiles').select('credits').eq('id', user.id).single();
  if (!profile) return json({ error: 'Perfil não encontrado.' }, 404);
  if (profile.credits <= 0) return json({ error: 'Créditos esgotados. Aguarde a renovação do ciclo ou faça upgrade.' }, 402);

  // ---- Conversa: valida propriedade ou cria ----
  let convoId: string = body.conversation_id ?? '';
  const isNew = !convoId;
  if (isNew) {
    const title = content.trim().slice(0, 60) || 'Nova conversa';
    const { data: convo, error: cErr } = await admin
      .from('conversations')
      .insert({ user_id: user.id, title, agent_id: body.agent_id ?? null, model_id: body.model ?? null })
      .select('id')
      .single();
    if (cErr || !convo) return json({ error: 'Falha ao criar conversa.' }, 500);
    convoId = convo.id;
  } else {
    const { data: convo } = await admin.from('conversations').select('id, user_id').eq('id', convoId).single();
    if (!convo || convo.user_id !== user.id) return json({ error: 'Conversa não encontrada.' }, 404);
  }

  // ---- System prompt (agente) ----
  let systemPrompt = DEFAULT_SYSTEM;
  let agentName = 'Orbit';
  if (body.agent_id) {
    const { data: agent } = await admin.from('agents').select('name, system_prompt').eq('id', body.agent_id).single();
    if (agent) { systemPrompt = agent.system_prompt || DEFAULT_SYSTEM; agentName = agent.name; }
  }

  // ---- Modelo: valida contra o catálogo ----
  let model = DEFAULT_MODEL;
  let rate = 1;
  const requested = (body.model ?? '').toString();
  if (requested) {
    const { data: m } = await admin.from('models').select('id, rate').eq('id', requested).eq('is_active', true).single();
    if (m) { model = m.id; rate = Number(m.rate) || 1; }
  }

  // ---- Monta mensagem do usuário (com anexos) ----
  let userContent: any = content;
  const textAttachments: string[] = [];
  const imageParts: any[] = [];
  for (const att of attachments) {
    if (att?.kind === 'image' && att?.data_url) {
      imageParts.push({ type: 'image_url', image_url: { url: att.data_url } });
    } else if (att?.text) {
      textAttachments.push(`\n\n--- Arquivo anexado: ${att.name || 'arquivo'} ---\n${String(att.text).slice(0, 20000)}`);
    }
  }
  if (imageParts.length) {
    userContent = [{ type: 'text', text: content + textAttachments.join('') }, ...imageParts];
  } else if (textAttachments.length) {
    userContent = content + textAttachments.join('');
  }

  // ---- Grava mensagem do usuário ----
  await admin.from('messages').insert({
    conversation_id: convoId,
    role: 'user',
    content,
    attachments: attachments.map((a: any) => ({ name: a.name, kind: a.kind, size: a.size })),
  });

  // ---- Histórico ----
  const { data: history } = await admin
    .from('messages')
    .select('role, content')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: true })
    .limit(60);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history ?? []).slice(0, -1).map((m: any) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  // ---- Chamada upstream (streaming) ----
  const upstream = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`,
      'HTTP-Referer': APP_URL,
      'X-Title': 'OrbitAI',
    },
    body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }),
  });

  if (!upstream.ok || !upstream.body) {
    let msg = `HTTP ${upstream.status}`;
    try { const j = await upstream.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    return json({ error: `Provedor de IA: ${msg}` }, 502);
  }

  // ---- Pipe SSE: repassa chunks ao cliente e acumula p/ gravar depois ----
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let acc = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  const stream = new ReadableStream({
    async start(controller) {
      // meta inicial: id da conversa + agente/modelo efetivos
      controller.enqueue(encoder.encode(sseEvent({ type: 'meta', conversation_id: convoId, agent: agentName, model })));
      const reader = upstream.body!.getReader();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const data = s.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) {
                acc += delta;
                controller.enqueue(encoder.encode(sseEvent({ type: 'delta', content: delta })));
              }
              if (j.usage) usage = j.usage;
            } catch { /* linha parcial */ }
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(sseEvent({ type: 'error', error: String(e) })));
      }

      // ---- Pós-stream: grava resposta, uso e débito de créditos ----
      try {
        if (acc.trim()) {
          const tokensIn = usage.prompt_tokens || Math.round(JSON.stringify(messages).length / 4);
          const tokensOut = usage.completion_tokens || Math.round(acc.length / 4);
          const cost = Math.max(1, Math.ceil(((tokensIn + tokensOut) / 1000) * rate));

          await admin.from('messages').insert({
            conversation_id: convoId,
            role: 'assistant',
            content: acc,
            model,
            usage: { input: tokensIn, output: tokensOut },
          });
          await admin.from('usage_events').insert({
            user_id: user.id,
            conversation_id: convoId,
            model,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            credits: cost,
          });
          await admin.from('profiles').update({ credits: Math.max(0, profile.credits - cost) }).eq('id', user.id);
          await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convoId);
        }
        controller.enqueue(encoder.encode(sseEvent({ type: 'done', conversation_id: convoId })));
      } catch (e) {
        controller.enqueue(encoder.encode(sseEvent({ type: 'error', error: 'Falha ao gravar resposta: ' + String(e) })));
      }
      controller.close();
    },
    cancel() { upstream.body?.cancel().catch(() => {}); },
  });

  return new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});
