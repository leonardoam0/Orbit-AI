import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { json } from "./cors.ts";

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function requireUser(req: Request): Promise<{ user: User; admin: SupabaseClient } | Response> {
  const header = req.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return json({ error: "missing_authorization" }, 401);

  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json({ error: "invalid_session" }, 401);
  return { user: data.user, admin };
}

export async function requireWorkspaceMember(
  req: Request,
  workspaceId: string,
): Promise<{ user: User; admin: SupabaseClient } | Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { data, error } = await auth.admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error || !data) return json({ error: "workspace_forbidden" }, 403);
  return auth;
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}
