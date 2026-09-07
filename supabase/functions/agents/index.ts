import { json, options } from "../_shared/cors.ts";
import { isResponse, requireWorkspaceMember } from "../_shared/auth.ts";

async function isAdmin(admin: any, workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return data?.role === "owner" || data?.role === "admin";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return options();
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id") || "";
  if (!workspaceId) return json({ error: "workspace_id_required" }, 400);
  const auth = await requireWorkspaceMember(req, workspaceId);
  if (isResponse(auth)) return auth;

  if (req.method === "GET") {
    const { data, error } = await auth.admin.from("agents").select("id, name, slug, description, system_prompt, model, provider, tools, is_default, is_public, created_at, updated_at").eq("workspace_id", workspaceId).order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    return json({ agents: data || [] });
  }

  if (!(await isAdmin(auth.admin, workspaceId, auth.user.id))) return json({ error: "workspace_admin_required" }, 403);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || body.name.trim().length < 2) return json({ error: "name_required" }, 400);
  const prompt = String(body.system_prompt || "Você é um assistente útil, preciso e seguro.");
  if (prompt.length > 12000) return json({ error: "system_prompt_too_long" }, 400);
  const agent = await auth.admin.from("agents").insert({
    workspace_id: workspaceId,
    name: body.name.trim().slice(0, 100),
    slug: slugify(body.slug || body.name),
    description: String(body.description || "").slice(0, 500),
    system_prompt: prompt,
    model: String(body.model || "").slice(0, 160),
    provider: String(body.provider || "openai-compatible"),
    tools: Array.isArray(body.tools) ? body.tools : [],
    is_default: Boolean(body.is_default),
    is_public: Boolean(body.is_public),
    created_by: auth.user.id,
  }).select().single();
  if (agent.error) return json({ error: agent.error.message }, 500);
  return json({ agent: agent.data }, 201);
});
