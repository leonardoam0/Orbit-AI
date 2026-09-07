/* ============================================================
   OrbitAI — db.js
   Cliente Supabase + camada de dados (auth, conversas,
   mensagens, agentes, modelos, uso, shares, storage).
   Expõe tudo em window.OrbitDB para o app.js (sem build).
   ============================================================ */
(function () {
  'use strict';

  const cfg = window.ORBIT_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('SEU-PROJETO') &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('SUA-ANON-KEY');

  let sb = null;
  if (configured && window.supabase) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  /* ---------------- Auth ---------------- */
  async function getSession() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session;
  }
  async function getUser() {
    const s = await getSession();
    return s ? s.user : null;
  }
  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function signUp(email, password, fullName) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw error;
    return data;
  }
  async function signInGoogle() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname.replace(/[^/]*$/, 'index.html') },
    });
    if (error) throw error;
  }
  async function signOut() { await sb.auth.signOut(); }
  function onAuthChange(cb) { return sb.auth.onAuthStateChange(cb); }

  /* ---------------- Perfil / uso ---------------- */
  async function getProfile() {
    const { data, error } = await sb.from('profiles').select('*').single();
    if (error) throw error;
    return data;
  }
  async function usageSummary() {
    const { data, error } = await sb
      .from('usage_events')
      .select('model, tokens_in, tokens_out, credits, created_at');
    if (error) throw error;
    return data || [];
  }

  /* ---------------- Modelos ---------------- */
  async function listModels() {
    const { data, error } = await sb.from('models').select('*').eq('is_active', true).order('sort');
    if (error) throw error;
    return data || [];
  }

  /* ---------------- Agentes ---------------- */
  async function listAgents() {
    const { data, error } = await sb.from('agents').select('*').order('created_at');
    if (error) throw error;
    return data || [];
  }
  async function createAgent(agent) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('agents')
      .insert({ ...agent, owner_id: user.id })
      .select().single();
    if (error) throw error;
    return data;
  }
  async function updateAgent(id, patch) {
    const { data, error } = await sb.from('agents').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  async function deleteAgent(id) {
    const { error } = await sb.from('agents').delete().eq('id', id);
    if (error) throw error;
  }

  /* ---------------- Conversas ---------------- */
  async function listConversations() {
    const { data, error } = await sb
      .from('conversations')
      .select('id, title, agent_id, model_id, updated_at, agents(name, icon)')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function getConversation(id) {
    const { data, error } = await sb.from('conversations').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  }
  async function updateConversation(id, patch) {
    const { error } = await sb.from('conversations').update(patch).eq('id', id);
    if (error) throw error;
  }
  async function deleteConversation(id) {
    const { error } = await sb.from('conversations').delete().eq('id', id);
    if (error) throw error;
  }

  /* ---------------- Mensagens ---------------- */
  async function listMessages(conversationId) {
    const { data, error } = await sb
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at');
    if (error) throw error;
    return data || [];
  }
  async function setFeedback(messageId, value) {
    const { error } = await sb.from('messages').update({ feedback: value }).eq('id', messageId);
    if (error) throw error;
  }

  /* ---------------- Chat (Edge Function, SSE) ---------------- */
  async function streamChat({ conversationId, content, agentId, model, attachments, onDelta, onMeta, signal }) {
    const session = await getSession();
    if (!session) throw new Error('Sessão expirada. Faça login novamente.');

    const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        conversation_id: conversationId || undefined,
        content,
        agent_id: agentId || undefined,
        model: model || undefined,
        attachments: attachments || undefined,
      }),
      signal,
    });

    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* ignore */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let meta = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        try {
          const j = JSON.parse(s.slice(5).trim());
          if (j.type === 'meta') { meta = j; if (onMeta) onMeta(j); }
          else if (j.type === 'delta') { full += j.content; onDelta(full); }
          else if (j.type === 'error') throw new Error(j.error);
        } catch (e) { if (e.message && !e.message.startsWith('Unexpected')) throw e; }
      }
    }
    return { content: full, meta };
  }

  /* ---------------- Shares ---------------- */
  function makeSlug() {
    return Array.from(crypto.getRandomValues(new Uint8Array(9)))
      .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  }
  async function createShare(conversationId) {
    const { data: { user } } = await sb.auth.getUser();
    const slug = makeSlug();
    const { data, error } = await sb.from('shares')
      .insert({ slug, conversation_id: conversationId, user_id: user.id })
      .select().single();
    if (error) throw error;
    return data;
  }
  async function getShared(slug) {
    const { data: share, error } = await sb.from('shares').select('*').eq('slug', slug).single();
    if (error) throw error;
    const { data: convo } = await sb.from('conversations').select('title, created_at').eq('id', share.conversation_id).single();
    const { data: msgs } = await sb.from('messages').select('role, content, model, created_at')
      .eq('conversation_id', share.conversation_id).order('created_at');
    return { share, convo, messages: msgs || [] };
  }

  /* ---------------- Storage (anexos) ---------------- */
  async function uploadAttachment(file, userId) {
    const path = userId + '/' + Date.now() + '_' + file.name.replace(/[^\w.\-]+/g, '_');
    const { error } = await sb.storage.from('attachments').upload(path, file);
    if (error) throw error;
    return path;
  }

  window.OrbitDB = {
    configured, sb,
    getSession, getUser, signIn, signUp, signInGoogle, signOut, onAuthChange,
    getProfile, usageSummary,
    listModels,
    listAgents, createAgent, updateAgent, deleteAgent,
    listConversations, getConversation, updateConversation, deleteConversation,
    listMessages, setFeedback,
    streamChat,
    createShare, getShared,
    uploadAttachment,
  };
})();
