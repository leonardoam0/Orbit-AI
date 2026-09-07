(function () {
  "use strict";

  const config = window.ORBIT_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase?.createClient);
  const client = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const functionBase = configured ? config.supabaseUrl.replace(/\/+$/, "") + "/functions/v1" : "";

  async function session() {
    if (!client) return null;
    const result = await client.auth.getSession();
    return result.data?.session || null;
  }

  async function invoke(name, body) {
    if (!client) throw new Error("Supabase não configurado. Copie js/orbit-config.example.js para js/orbit-config.js.");
    const result = await client.functions.invoke(name, { body: body || {} });
    if (result.error) throw new Error(result.error.message || "function_failed");
    return result.data;
  }

  async function bootstrap() {
    return invoke("bootstrap", {});
  }

  async function listProviders(workspaceId) {
    const token = await session();
    if (!token) throw new Error("login_required");
    const res = await fetch(functionBase + "/providers?workspace_id=" + encodeURIComponent(workspaceId), {
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token.access_token },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "providers_failed");
    return data.providers || [];
  }

  async function saveProvider(input) {
    return invoke("providers?workspace_id=" + encodeURIComponent(input.workspace_id), input);
  }

  async function listAgents(workspaceId) {
    const token = await session();
    if (!token) throw new Error("login_required");
    const res = await fetch(functionBase + "/agents?workspace_id=" + encodeURIComponent(workspaceId), {
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token.access_token },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "agents_failed");
    return data.agents || [];
  }

  async function createAgent(input) {
    return invoke("agents?workspace_id=" + encodeURIComponent(input.workspace_id), input);
  }

  async function streamChat(input, onEvent, signal) {
    const current = await session();
    if (!current) throw new Error("login_required");
    const res = await fetch(functionBase + "/chat", {
      method: "POST",
      signal,
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: "Bearer " + current.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || error.error || "chat_failed");
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("stream_unavailable");
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        let name = "message";
        let raw = "";
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          if (line.startsWith("data:")) raw += line.slice(5).trim();
        }
        if (!raw) continue;
        let payload;
        try { payload = JSON.parse(raw); } catch { continue; }
        if (name === "done") finalData = payload;
        if (typeof onEvent === "function") onEvent(name, payload);
      }
    }
    return finalData || {};
  }

  window.OrbitBackend = {
    configured,
    client,
    session,
    bootstrap,
    listProviders,
    saveProvider,
    listAgents,
    createAgent,
    streamChat,
    onAuthStateChange(callback) {
      return client ? client.auth.onAuthStateChange(callback) : { data: { subscription: { unsubscribe() {} } } };
    },
    async signIn(email, password) {
      if (!client) throw new Error("Supabase não configurado.");
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      return result.data;
    },
    async signUp(email, password, fullName) {
      if (!client) throw new Error("Supabase não configurado.");
      const result = await client.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
      if (result.error) throw result.error;
      return result.data;
    },
    async signOut() {
      if (client) await client.auth.signOut();
    },
  };
})();
