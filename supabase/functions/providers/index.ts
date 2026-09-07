import { corsHeaders, json, options } from "../_shared/cors.ts";
import { isResponse, requireWorkspaceMember } from "../_shared/auth.ts";
import { encryptSecret } from "../_shared/crypto.ts";

const allowedProviders = new Set(["openai-compatible", "anthropic", "openrouter", "sglang"]);

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return options();
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id") || "";
  if (!workspaceId) return json({ error: "workspace_id_required" }, 400);

  const auth = await requireWorkspaceMember(req, workspaceId);
  if (isResponse(auth)) return auth;

  if (req.method === "GET") {
    const { data, error } = await auth.admin
      .from("provider_credentials")
      .select("id, label, provider, base_url, model, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json({ providers: data || [] });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "provider_id_required" }, 400);
    const deleted = await auth.admin.from("provider_credentials").delete().eq("id", id).eq("workspace_id", workspaceId);
    if (deleted.error) return json({ error: deleted.error.message }, 500);
    return json({ ok: true });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.json().catch(() => null);
  if (!body || !allowedProviders.has(body.provider)) return json({ error: "unsupported_provider" }, 400);
  if (!body.model || typeof body.model !== "string" || body.model.length > 160) return json({ error: "model_required" }, 400);
  const baseUrl = String(body.base_url || (body.provider === "anthropic" ? "https://api.anthropic.com" : body.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"));
  if (!validBaseUrl(baseUrl)) return json({ error: "invalid_base_url" }, 400);
  if (typeof body.api_key !== "string" || body.api_key.length < 1 || body.api_key.length > 500) return json({ error: "api_key_required" }, 400);

  const encrypted = await encryptSecret(body.api_key);
  const saved = await auth.admin.from("provider_credentials").upsert({
    workspace_id: workspaceId,
    label: String(body.label || "Principal").slice(0, 80),
    provider: body.provider,
    base_url: baseUrl.replace(/\/+$/, ""),
    model: body.model,
    encrypted_api_key: encrypted,
    created_by: auth.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,provider,label" }).select("id, label, provider, base_url, model, created_at, updated_at").single();
  if (saved.error) return json({ error: saved.error.message }, 500);
  return json({ provider: saved.data }, 201);
});
