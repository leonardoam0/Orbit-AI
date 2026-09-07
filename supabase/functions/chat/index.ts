import { json, options, corsHeaders } from "../_shared/cors.ts";
import { isResponse, requireWorkspaceMember } from "../_shared/auth.ts";
import { decryptSecret } from "../_shared/crypto.ts";

type Usage = { input_tokens: number; output_tokens: number };

function event(name: string, payload: unknown): string {
  return "event: " + name + "\ndata: " + JSON.stringify(payload) + "\n\n";
}

function chatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : base + "/chat/completions";
}

function anthropicUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1/messages") ? base : base + "/v1/messages";
}

function textFromOpenAI(packet: any): string {
  return packet?.choices?.[0]?.delta?.content || packet?.choices?.[0]?.message?.content || "";
}

function readUsage(packet: any): Usage {
  return {
    input_tokens: Number(packet?.usage?.prompt_tokens || packet?.usage?.input_tokens || 0),
    output_tokens: Number(packet?.usage?.completion_tokens || packet?.usage?.output_tokens || 0),
  };
}

async function parseUpstream(
  upstream: Response,
  provider: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<{ content: string; usage: Usage }> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("provider_stream_unavailable");
  let buffer = "";
  let content = "";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  const push = (name: string, payload: unknown) => controller.enqueue(encoder.encode(event(name, payload)));

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += new TextDecoder().decode(chunk.value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      let eventName = "";
      let dataLine = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine || dataLine === "[DONE]") continue;

      let packet: any;
      try { packet = JSON.parse(dataLine); } catch { continue; }

      let delta = "";
      if (provider === "anthropic") {
        if (packet.type === "content_block_delta") delta = packet.delta?.text || "";
        if (packet.type === "message_delta") {
          usage = {
            input_tokens: usage.input_tokens,
            output_tokens: Number(packet.usage?.output_tokens || usage.output_tokens || 0),
          };
        }
      } else {
        delta = textFromOpenAI(packet);
        const next = readUsage(packet);
        if (next.input_tokens || next.output_tokens) usage = next;
      }

      if (delta) {
        content += delta;
        push("token", { delta, content });
      }
      if (eventName === "message_stop" || packet.type === "message_stop") push("provider", { type: "message_stop" });
    }
  }

  return { content, usage };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return options();

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const workspaceId = String(body?.workspace_id || "");
  const content = String(body?.content || "").trim();
  if (!workspaceId || !content) return json({ error: "workspace_id_and_content_required" }, 400);
  if (content.length > 50000) return json({ error: "content_too_long" }, 413);

  const auth = await requireWorkspaceMember(req, workspaceId);
  if (isResponse(auth)) return auth;

  let conversationId = String(body?.conversation_id || "");
  if (conversationId) {
    const existing = await auth.admin.from("conversations").select("*").eq("id", conversationId).eq("workspace_id", workspaceId).maybeSingle();
    if (existing.error || !existing.data) return json({ error: "conversation_not_found" }, 404);
  } else {
    const created = await auth.admin.from("conversations").insert({
      workspace_id: workspaceId,
      agent_id: body?.agent_id || null,
      created_by: auth.user.id,
      title: content.slice(0, 80),
    }).select().single();
    if (created.error || !created.data) return json({ error: created.error?.message || "conversation_create_failed" }, 500);
    conversationId = created.data.id;
  }

  const agentQuery = auth.admin.from("agents").select("*").eq("workspace_id", workspaceId);
  const agent = body?.agent_id
    ? await agentQuery.eq("id", body.agent_id).maybeSingle()
    : await agentQuery.eq("is_default", true).maybeSingle();
  if (agent.error || !agent.data) return json({ error: "agent_not_found" }, 404);

  const credentialQuery = auth.admin.from("provider_credentials")
    .select("id, provider, base_url, model, encrypted_api_key, created_at")
    .eq("workspace_id", workspaceId);
  const credential = body?.provider_credential_id
    ? await credentialQuery.eq("id", body.provider_credential_id).maybeSingle()
    : await credentialQuery.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (credential.error || !credential.data) {
    return json({ error: "provider_not_configured", message: "Configure um provedor em Configurações antes de conversar." }, 400);
  }

  const userMessage = await auth.admin.from("messages").insert({
    conversation_id: conversationId,
    role: "user",
    content,
    provider: credential.data.provider,
    model: agent.data.model || credential.data.model,
  }).select().single();
  if (userMessage.error) return json({ error: userMessage.error.message }, 500);

  const history = await auth.admin.from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (history.error) return json({ error: history.error.message }, 500);

  const apiKey = await decryptSecret(credential.data.encrypted_api_key);
  const model = agent.data.model || credential.data.model;
  const systemPrompt = agent.data.system_prompt || "Você é um assistente útil, preciso e seguro.";
  const historyRows = (history.data || []).filter((row: any) => row.role === "user" || row.role === "assistant");
  const openaiMessages = [{ role: "system", content: systemPrompt }, ...historyRows];
  const anthropicMessages = historyRows;

  let upstream: Response;
  if (credential.data.provider === "anthropic") {
    upstream = await fetch(anthropicUrl(credential.data.base_url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages: anthropicMessages, stream: true }),
    });
  } else {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey !== "local") headers.Authorization = "Bearer " + apiKey;
    if (credential.data.provider === "openrouter") {
      headers["HTTP-Referer"] = Deno.env.get("ORBIT_PUBLIC_URL") || "https://orbitai.my";
      headers["X-Title"] = "OrbitAI";
    }
    upstream = await fetch(chatUrl(credential.data.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: openaiMessages, stream: true, stream_options: { include_usage: true } }),
    });
  }

  if (!upstream.ok) {
    const details = await upstream.text().catch(() => "");
    return json({ error: "provider_request_failed", status: upstream.status, details: details.slice(0, 1200) }, 502);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      (async () => {
        try {
          controller.enqueue(encoder.encode(event("meta", { conversation_id: conversationId, message_id: userMessage.data.id, model, provider: credential.data.provider })));
          const result = await parseUpstream(upstream, credential.data.provider, controller, encoder);

          const assistant = await auth.admin.from("messages").insert({
            conversation_id: conversationId,
            role: "assistant",
            content: result.content,
            model,
            provider: credential.data.provider,
            usage: result.usage,
          }).select().single();

          await auth.admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
          await auth.admin.from("usage_events").insert({
            workspace_id: workspaceId,
            user_id: auth.user.id,
            conversation_id: conversationId,
            provider: credential.data.provider,
            model,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
          });

          controller.enqueue(encoder.encode(event("done", {
            conversation_id: conversationId,
            message_id: assistant.data?.id || null,
            content: result.content,
            usage: result.usage,
          })));
        } catch (error) {
          controller.enqueue(encoder.encode(event("error", { error: error instanceof Error ? error.message : "stream_failed" })));
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});
