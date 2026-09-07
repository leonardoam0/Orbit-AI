import { corsHeaders, json, options } from "../_shared/cors.ts";
import { adminClient, requireUser, isResponse } from "../_shared/auth.ts";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return options();
  const auth = await requireUser(req);
  if (isResponse(auth)) return auth;

  const { user, admin } = auth;
  const existing = await admin
    .from("workspace_members")
    .select("workspace_id, role, workspaces(*)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing.data?.workspace_id && existing.data.workspaces) {
    const agent = await admin.from("agents").select("*").eq("workspace_id", existing.data.workspace_id).eq("is_default", true).maybeSingle();
    return json({ workspace: existing.data.workspaces, agent: agent.data || null });
  }

  const base = slugify(user.user_metadata?.full_name || user.email?.split("@")[0] || "workspace");
  const workspace = await admin.from("workspaces").insert({
    name: (user.user_metadata?.full_name || "Meu") + " Workspace",
    slug: base + "-" + crypto.randomUUID().slice(0, 8),
    owner_id: user.id,
  }).select().single();
  if (workspace.error || !workspace.data) return json({ error: workspace.error?.message || "workspace_create_failed" }, 500);

  const member = await admin.from("workspace_members").insert({
    workspace_id: workspace.data.id,
    user_id: user.id,
    role: "owner",
  });
  if (member.error) return json({ error: member.error.message }, 500);

  const agent = await admin.from("agents").insert({
    workspace_id: workspace.data.id,
    name: "Orbit Assistant",
    slug: "orbit-assistant",
    description: "Assistente geral da sua workspace.",
    system_prompt: "Você é o Orbit Assistant. Responda em português do Brasil, seja direto, honesto sobre incertezas e nunca invente ações que não executou.",
    is_default: true,
    created_by: user.id,
  }).select().single();
  if (agent.error) return json({ error: agent.error.message }, 500);

  return json({ workspace: workspace.data, agent: agent.data }, 201);
});
