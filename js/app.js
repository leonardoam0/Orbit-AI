/* ============================================================
   OrbitAI — app.js
   Estado, autenticação, chat por streaming, provedores e navegação.
   Vanilla JS de interface; o processamento de IA ocorre no backend..
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------
     Constantes
  ---------------------------------------------------------- */
  const MODELS = [
    { id: 'configured', name: 'Modelo configurado', icon: 'ph-plugs', accent: 'text-app-accent', rate: 0 },
  ];

  const SUGGESTIONS = [
    'Crie um plano de lançamento para meu SaaS',
    'Me ajude a refatorar um endpoint REST',
    'Explique React Server Components',
    'Compare Vite e Webpack para meu monorepo',
  ];

  const CREDIT_TOTAL = 100000;

  /* ----------------------------------------------------------
     Estado persistido
  ---------------------------------------------------------- */
  const STORAGE_KEY = 'orbitai.state.v1';

  function seedState() {
    return {
      conversations: [],
      activeId: null,
      model: '',
      workspace: 'Meu Workspace',
      tokens: { used: 0 },
      backend: { workspaceId: null, agentId: null, providerId: null },
      provider: { mode: 'backend', baseUrl: '', model: '', apiKey: '', credentialId: null },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.conversations)) return null;
      return s;
    } catch {
      return null;
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadState() || seedState();
  if (state.provider?.mode === 'sim') state = seedState();
  state.tokens = state.tokens || state['credits'] || { used: 0 };
  state.backend = state.backend || { workspaceId: null, agentId: null, providerId: null };
  state.provider = { mode: 'backend', baseUrl: state.provider?.baseUrl || '', model: state.provider?.model || '', apiKey: '', credentialId: state.provider?.credentialId || null };
  state.activeId = state.activeId || state.conversations[0]?.id || null;
  saveState();

  function uid() {
    return 'c_' + Math.random().toString(36).slice(2, 10);
  }

  /* ----------------------------------------------------------
     Utilitários
  ---------------------------------------------------------- */
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.floor(h / 24);
    if (d === 1) return 'Ontem';
    return d + ' dias';
  }

  function formatNumber(n) {
    return n.toLocaleString('pt-BR').replace(/\./g, ',').replace(',', '.');
  }

  /* Markdown leve: blocos de código, listas, título, negrito, itálico, código inline, links [texto](url) */
  function renderMarkdown(src) {
    let codes = [];
    let text = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
      codes.push({ lang: lang || 'code', code });
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    let html = escapeHtml(text)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>');

    const lines = html.split('\n');
    let out = '';
    let inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };

    for (let line of lines) {
      const mCode = line.match(/^\u0000(\d+)\u0000$/);
      if (mCode) {
        closeLists();
        const c = codes[+mCode[1]];
        out += '<div class="code-block"><div class="flex items-center justify-between px-4 py-2 bg-white/[0.03] border-b border-app-border text-xs text-app-text"><span>' + escapeHtml(c.lang) + '</span><button class="copy-code flex items-center gap-1.5 hover:text-app-textLight transition-colors"><i class="ph ph-copy"></i> Copiar</button></div><pre><code>' + escapeHtml(c.code) + '</code></pre></div>';
        continue;
      }
      if (/^###\s/.test(line)) { closeLists(); out += '<h3>' + line.replace(/^###\s/, '') + '</h3>'; }
      else if (/^##\s/.test(line)) { closeLists(); out += '<h2>' + line.replace(/^##\s/, '') + '</h2>'; }
      else if (/^#\s/.test(line)) { closeLists(); out += '<h1>' + line.replace(/^#\s/, '') + '</h1>'; }
      else if (/^-{3,}$/.test(line)) { closeLists(); out += '<hr>'; }
      else if (/^-\s/.test(line)) { if (inOl) { out += '</ol>'; inOl = false; } if (!inUl) { out += '<ul>'; inUl = true; } out += '<li>' + line.replace(/^-\s/, '') + '</li>'; }
      else if (/^\d+\.\s/.test(line)) { if (inUl) { out += '</ul>'; inUl = false; } if (!inOl) { out += '<ol>'; inOl = true; } out += '<li>' + line.replace(/^\d+\.\s/, '') + '</li>'; }
      else if (line.trim() === '') { closeLists(); }
      else { closeLists(); out += '<p>' + line + '</p>'; }
    }
    closeLists();
    return out;
  }

  /* ----------------------------------------------------------
     Providers
  ---------------------------------------------------------- */
  let generation = { stop: false, controller: null };

  class StopError extends Error { constructor() { super('stop'); this.name = 'StopError'; } }
  class ProviderError extends Error { constructor(msg, status) { super(msg); this.name = 'ProviderError'; this.status = status; } }

  function activeProvider() {
    if (window.OrbitBackend?.configured && state.backend?.workspaceId) return 'backend';
    return 'unavailable';
  }

  /* ----------------------------------------------------------
     Renderização
  ---------------------------------------------------------- */
  function activeConvo() {
    return state.conversations.find((c) => c.id === state.activeId) || null;
  }

  function renderSidebar() {
    const list = $('#convList');
    const q = ($('#searchInput').value || '').trim().toLowerCase();
    const items = state.conversations
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.role === 'user' && m.content.toLowerCase().includes(q)));

    list.innerHTML = items.map((c) => {
      const active = c.id === state.activeId;
      const last = c.messages[c.messages.length - 1];
      const t = last ? relTime(last.ts || Date.now()) : '';
      return (
        '<button class="conv-item group w-full flex items-center justify-between px-2.5 py-2 rounded-md ' +
        (active ? 'bg-white/10 text-app-textLight' : 'hover:bg-white/5 text-app-text hover:text-app-textLight') +
        ' text-sm transition-colors" data-id="' + c.id + '">' +
        '<span class="flex items-center gap-2 truncate"><i class="ph ph-chat-teardrop-text"></i> ' + escapeHtml(c.title) + '</span>' +
        '<span class="flex items-center gap-2 flex-shrink-0">' +
        '<span class="text-[10px] text-app-text">' + t + '</span>' +
        (active ? '<span class="w-1.5 h-1.5 rounded-full bg-app-accent"></span>' :
          '<i class="ph ph-trash text-[11px] text-app-text/40 group-hover:text-app-red hidden group-hover:inline" data-del="' + c.id + '" aria-label="Excluir conversa"></i>') +
        '</span></button>'
      );
    }).join('');
    if (!items.length) list.innerHTML = '<div class="text-xs text-app-text px-2 py-4 text-center">Nenhuma conversa encontrada.</div>';
  }

  function msgEl(m, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    if (m.role === 'user') {
      wrap.className = 'flex flex-col items-end gap-1 msg-enter';
      wrap.innerHTML =
        '<div class="text-xs text-app-text mr-1">' + relTime(m.ts || Date.now()) + ' <span class="bg-white/10 w-5 h-5 inline-flex items-center justify-center rounded-full ml-2 text-[10px] text-white">LO</span></div>' +
        '<div class="bg-app-panel border border-app-border text-app-textLight px-4 py-3 rounded-2xl rounded-tr-sm max-w-2xl text-sm leading-relaxed shadow-lg whitespace-pre-wrap">' + escapeHtml(m.content) + '</div>';
      return wrap;
    }
    // assistant
    const modelInfo = MODELS.find((mm) => mm.id === m.model);
    const modelLabel = modelInfo ? modelInfo.name : (m.model || 'Modelo');
    wrap.className = 'flex gap-4 max-w-4xl msg-enter';

    // Avatar à esquerda, coluna de conteúdo à direita
    const avatar = document.createElement('div');
    avatar.className = 'w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-app-textLight flex-shrink-0 mt-1';
    avatar.innerHTML = '<i class="ph-fill ph-robot text-lg"></i>';
    const content = document.createElement('div');
    content.className = 'flex-1 min-w-0';
    content.innerHTML =
      '<div class="flex items-center gap-2 text-xs text-app-text mb-2 flex-wrap">' +
      '<span class="font-medium text-app-textLight">Orbit Assistant</span>' +
      '<span class="bg-white/5 border border-white/10 rounded-full px-2 py-0.5 leading-none">' + escapeHtml(modelLabel) + '</span>' +
      '<span>' + relTime(m.ts || Date.now()) + '</span></div>' +
      '<div class="prose">' + renderMarkdown(m.content) + '</div>' +
      (m.thinking ?
        '<div class="glass-panel rounded-xl mt-3">' +
        '<button class="think-toggle w-full flex items-center justify-between px-4 py-3 text-left">' +
        '<span class="flex items-center gap-2 text-xs text-app-text"><i class="ph ph-brain text-app-accent"></i> <span class="font-medium text-app-textLight">Pensamento resumido</span></span>' +
        '<i class="ph ph-caret-down text-app-text text-xs"></i></button>' +
        '<div class="think-body px-4 pb-3 text-xs text-app-text hidden">' + escapeHtml(m.thinking) + '</div>' +
        '</div>' : '');

    // Ações da mensagem (agente) — dentro da coluna de conteúdo, abaixo do texto
    const fb = m.feedback;
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2 mt-3 flex-wrap';
    actions.innerHTML =
      '<button data-act="copy" class="mact flex items-center gap-2 px-3 py-1.5 rounded-md border border-app-border bg-app-panel text-xs text-app-text hover:bg-white/10 hover:text-app-textLight transition-all"><i class="ph ph-copy"></i> Copiar</button>' +
      '<button data-act="like" class="mact flex items-center gap-2 px-3 py-1.5 rounded-md border ' + (fb === 1 ? 'border-app-accent/50 text-app-accent bg-app-accent/10' : 'border-app-border bg-app-panel text-app-text hover:bg-white/10 hover:text-app-textLight') + ' text-xs transition-all"><i class="ph' + (fb === 1 ? '-fill' : '') + ' ph-thumbs-up"></i> Avaliar</button>' +
      '<button data-act="dislike" class="mact flex items-center gap-2 px-3 py-1.5 rounded-md border ' + (fb === -1 ? 'border-app-red/50 text-app-red bg-app-red/10' : 'border-app-border bg-app-panel text-app-text hover:bg-white/10 hover:text-app-textLight') + ' text-xs transition-all" aria-label="Esta resposta não ajudou"><i class="ph' + (fb === -1 ? '-fill' : '') + ' ph-thumbs-down"></i> Melhorar</button>' +
      (opts.isLast ?
        '<div class="ml-auto flex gap-2">' +
        '<button data-act="regen" class="flex items-center gap-2 px-3 py-1.5 rounded-md border border-app-border bg-app-panel text-xs text-app-text hover:bg-white/10 hover:text-app-textLight transition-all"><i class="ph ph-arrows-clockwise"></i> Regenerar</button>' +
        '<button data-act="continue" class="flex items-center gap-2 px-3 py-1.5 rounded-md border border-app-border bg-app-panel text-xs text-app-text hover:bg-white/10 hover:text-app-textLight transition-all"><i class="ph ph-arrow-right"></i> Continuar</button>' +
        '</div>' :
        (m.usage ? '<span class="ml-auto text-[10px] text-app-text font-mono">' + (m.usage.input + m.usage.output) + ' tokens</span>' : ''));

    content.appendChild(actions);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    return wrap;
  }

  function renderChat(animate) {
    const chat = $('#chat');
    const convo = activeConvo();
    const chatScroll = $('#chatScroll');
    chat.innerHTML = '';
    const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
    if (!convo || !convo.messages.length) {
      $('#emptyState').classList.remove('hidden');
      renderSuggestions();
      return;
    }
    $('#emptyState').classList.add('hidden');
    convo.messages.forEach((m, i) => {
      const el = msgEl(m, { isLast: i === convo.messages.length - 1 });
      if (animate && !reducedMotion) el.style.animationDelay = Math.min(i * 80, 400) + 'ms';
      chat.appendChild(el);
    });
    if (nearBottom || animate) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function renderSuggestions() {
    const box = $('#suggestChips');
    box.innerHTML = SUGGESTIONS.map((s, i) =>
      '<button data-suggest="' + i + '" style="animation-delay:' + (i * 70) + 'ms" class="chip animate-fade-in px-3 py-2 rounded-full border border-app-border bg-white/[0.03] hover:bg-white/10 hover:border-app-accent/40 text-xs text-app-text hover:text-app-textLight transition-all active:scale-95">' +
      '<i class="ph ph-lightbulb text-app-accent mr-1.5"></i>' + escapeHtml(s) + '</button>'
    ).join('');
  }

  function renderUsagePanel() {
    // Ciclo de créditos: rótulos calculados a partir da data atual
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthName = now.toLocaleDateString('pt-BR', { month: 'long' });
    const cycle = $('#cycleLabel');
    if (cycle) cycle.textContent = `1–${lastDay} de ${monthName}`;
    const daysLeft = lastDay - now.getDate();
    const renew = $('#renewLabel');
    if (renew) renew.textContent = daysLeft <= 0 ? 'Renova hoje' : daysLeft === 1 ? 'Renova em 1 dia' : `Renova em ${daysLeft} dias`;

    // Créditos
    const used = state.tokens.used;
    const remaining = Math.max(0, CREDIT_TOTAL - used);
    const pct = Math.min(100, Math.round((remaining / CREDIT_TOTAL) * 100));
    $('#tokensNum').textContent = formatNumber(remaining);
    $('#tokensPct').textContent = pct + '%';
    const bar = document.querySelector('.credit-bar');
    bar.style.width = pct + '%';
    bar.classList.toggle('is-critical', pct < 10);
    bar.classList.toggle('is-low', pct >= 10 && pct < 30);
    $('#tokensLow').classList.toggle('hidden', pct >= 30);

    // Uso por modelo
    const byModel = {};
    state.conversations.forEach((c) => c.messages.forEach((m) => {
      if (m.role === 'assistant' && m.usage) byModel[m.model] = (byModel[m.model] || 0) + m.usage.input + m.usage.output;
    }));
    const modelsTokens = Object.values(byModel).reduce((a, b) => a + b, 0);
    const tools = 0, storage = 0;
    const total = modelsTokens + tools + storage;

    function row(label, value, color, glow) {
      return '<div class="flex items-center justify-between text-xs">' +
        '<div class="flex items-center gap-2 text-app-textLight"><span class="w-2 h-2 rounded-full" style="background:' + color + ';box-shadow:0 0 5px ' + glow + '"></span> ' + label + '</div>' +
        '<span class="text-app-text font-mono">' + formatNumber(value) + '</span></div>';
    }
    $('#usageBreakdown').innerHTML =
      row('Modelos', modelsTokens, '#c0ff2d', 'rgba(192,255,45,0.5)') +
      row('Ferramentas', tools, '#3b82f6', 'rgba(59,130,246,0.5)') +
      row('Armazenamento', storage, '#a855f7', 'rgba(168,85,247,0.5)') +
      '<div class="pt-2 border-t border-white/10 flex items-center justify-between text-xs font-medium text-app-textLight mt-1"><span>Total</span><span class="font-mono">' + formatNumber(total) + '</span></div>';

    // Lista de modelos (clique para trocar)
    $('#modelList').innerHTML = MODELS.map((m) =>
      '<button data-model="' + m.id + '" class="model-row w-full flex items-center justify-between text-xs px-2.5 py-2 rounded-lg border transition-colors ' +
      (state.model === m.id ? 'bg-app-accent/10 border-app-accent/40 text-app-textLight' : 'border-transparent hover:bg-white/5 text-app-textLight') + '">' +
      '<span class="flex items-center gap-2"><i class="ph' + (m.accent.includes('sparkle') ? '-fill' : '') + ' ' + m.icon + ' ' + m.accent + '"></i> ' + m.name + '</span>' +
      '<span class="text-app-text font-mono">configurado</span>' +
      '</button>'
    ).join('');
  }

  function renderModelMenu() {
    $('#modelItems').innerHTML = MODELS.map((m) =>
      '<button data-model="' + m.id + '" class="menu-item w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/5 transition-colors ' +
      (state.model === m.id ? 'text-app-textLight' : 'text-app-text') + '">' +
      '<i class="ph' + (m.id === MODELS[0].id ? '-fill' : '') + ' ' + m.icon + ' ' + m.accent + '"></i> ' + m.name +
      (state.model === m.id ? '<i class="ph ph-check text-app-accent ml-auto"></i>' : '') +
      '</button>'
    ).join('');
    const m = MODELS.find((x) => x.id === state.model) || MODELS[0];
    $('#modelLabel').textContent = state.provider.model || m.name;
    $('#providerLabel').textContent = activeProvider() === 'backend' ? 'Orbit Backend' : 'Login necessário';
  }

  function renderWorkspace() {
    $('#wsLabel').textContent = state.workspace;
    $$('#wsMenu .menu-item').forEach((b) => {
      b.querySelector('.ph-check').classList.toggle('hidden', b.dataset.ws !== state.workspace);
    });
  }

  function rerenderAll() {
    renderSidebar();
    renderChat(false);
    renderUsagePanel();
    renderModelMenu();
    renderWorkspace();
    document.title = 'OrbitAI — ' + (activeConvo()?.title || 'novo');
  }

  /* ----------------------------------------------------------
     Backend / autenticação
  ---------------------------------------------------------- */
  async function refreshAgents() {
    const status = $('#agentsStatus');
    const list = $('#agentsList');
    if (!window.OrbitBackend?.configured || !state.backend?.workspaceId) {
      if (status) status.textContent = 'Entre em uma conta para carregar agentes.';
      return;
    }
    if (status) status.textContent = 'Carregando agentes…';
    try {
      const agents = await window.OrbitBackend.listAgents(state.backend.workspaceId);
      list.innerHTML = agents.map((agent) =>
        '<button data-agent-id="' + escapeHtml(agent.id) + '" class="w-full text-left rounded-xl border ' +
        (agent.id === state.backend.agentId ? 'border-app-accent/50 bg-app-accent/10' : 'border-app-border bg-white/[0.02] hover:bg-white/5') +
        ' p-3 transition-colors">' +
        '<div class="flex items-center justify-between gap-2"><span class="text-sm text-app-textLight font-medium">' + escapeHtml(agent.name) + '</span>' +
        (agent.is_default ? '<span class="text-[10px] text-app-accent">padrão</span>' : '') + '</div>' +
        '<div class="text-xs text-app-text mt-1">' + escapeHtml(agent.description || agent.system_prompt.slice(0, 120)) + '</div>' +
        '</button>'
      ).join('');
      if (!agents.length) list.innerHTML = '<div class="text-xs text-app-text">Nenhum agente encontrado.</div>';
      if (status) status.textContent = agents.length + ' agente(s) disponível(is).';
    } catch (error) {
      if (status) status.textContent = 'Falha ao carregar agentes: ' + (error.message || 'erro desconhecido');
    }
  }

  async function openAgents() {
    if (!window.OrbitBackend?.configured) {
      toast('Configure o Supabase antes de usar agentes.', 'warn');
      return;
    }
    if (!state.backend?.workspaceId) {
      openAuth();
      return;
    }
    const modal = $('#agentsModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    await refreshAgents();
  }

  function closeAgents() {
    const modal = $('#agentsModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  async function createAgentFromForm(event) {
    event.preventDefault();
    const status = $('#agentsStatus');
    try {
      const result = await window.OrbitBackend.createAgent({
        workspace_id: state.backend.workspaceId,
        name: $('#agentName').value.trim(),
        system_prompt: $('#agentPrompt').value.trim(),
        model: $('#agentModel').value.trim(),
      });
      if (result.agent?.id) state.backend.agentId = result.agent.id;
      saveState();
      $('#agentForm').reset();
      await refreshAgents();
      toast('Agente criado e selecionado.', 'success');
    } catch (error) {
      if (status) status.textContent = 'Não foi possível criar o agente: ' + (error.message || 'erro desconhecido');
    }
  }


  function openAuth() {
    const modal = $('#authModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    $('#authEmail')?.focus();
  }
  function closeAuth() {
    const modal = $('#authModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  async function syncBackendAccount() {
    if (!window.OrbitBackend?.configured) {
      state.backend = { workspaceId: null, agentId: null, providerId: null };
      saveState();
      rerenderAll();
      return;
    }
    try {
      const session = await window.OrbitBackend.session();
      if (!session) {
        state.backend = { workspaceId: null, agentId: null, providerId: null };
        const name = $('#accountName'); if (name) name.textContent = 'Visitante';
        const email = $('#accountEmail'); if (email) email.textContent = 'Entre para começar';
        saveState(); rerenderAll(); return;
      }
      const boot = await window.OrbitBackend.bootstrap();
      state.backend.workspaceId = boot.workspace?.id || null;
      state.backend.agentId = boot.agent?.id || null;
      state.workspace = boot.workspace?.name || state.workspace;
      const name = $('#accountName'); if (name) name.textContent = session.user.user_metadata?.full_name || session.user.email || 'Conta OrbitAI';
      const email = $('#accountEmail'); if (email) email.textContent = session.user.email || '';
      saveState(); rerenderAll();
    } catch (error) {
      toast('Falha ao iniciar o workspace: ' + (error.message || 'erro desconhecido'), 'error');
    }
  }
  async function authenticate(kind) {
    const status = $('#authStatus');
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const name = $('#authName').value.trim();
    if (!email || !password) return;
    status.textContent = kind === 'signup' ? 'Criando conta…' : 'Entrando…';
    status.className = 'text-xs text-app-text';
    try {
      if (kind === 'signup') {
        await window.OrbitBackend.signUp(email, password, name);
        status.textContent = 'Conta criada. Verifique seu email se a confirmação estiver ativada.';
      } else {
        await window.OrbitBackend.signIn(email, password);
        closeAuth();
        await syncBackendAccount();
        toast('Sessão iniciada.', 'success');
      }
    } catch (error) {
      status.textContent = error.message || 'Não foi possível autenticar.';
      status.className = 'text-xs text-app-red';
    }
  }

  /* ----------------------------------------------------------
     Ciclo do chat
  ---------------------------------------------------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || generating) return;
    if (activeProvider() !== 'backend') {
      if (!window.OrbitBackend?.configured) toast('Configure o Supabase antes de usar o chat.', 'warn');
      else openAuth();
      return;
    }

    let convo = activeConvo();
    let isNew = false;
    if (!convo) {
      convo = { id: uid(), title: 'Nova conversa', messages: [], updatedAt: Date.now() };
      state.conversations.push(convo);
      state.activeId = convo.id;
      isNew = true;
    }
    const userMsg = { role: 'user', content: text, ts: Date.now() };
    convo.messages.push(userMsg);
    if (isNew || convo.title === 'Nova conversa') {
      convo.title = text.length > 42 ? text.slice(0, 42) + '…' : text;
    }
    convo.updatedAt = Date.now();
    saveState();

    // Renderiza a mensagem do usuário
    const chat = $('#chat');
    $('#emptyState').classList.add('hidden');
    chat.appendChild(msgEl(userMsg));
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;

    // Placeholder do agente
    const placeholder = document.createElement('div');
    placeholder.className = 'flex gap-4 max-w-4xl msg-enter';
    placeholder.innerHTML =
      '<div class="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-app-textLight flex-shrink-0 mt-1"><i class="ph-fill ph-robot text-lg"></i></div>' +
      '<div class="flex-1 min-w-0"><div class="flex items-center gap-2 text-xs text-app-text mb-2"><span class="font-medium text-app-textLight">Devin</span> ' +
      '<span class="typing-dots"><span></span><span></span><span></span></span></div>' +
      '<div class="prose stream-target text-app-text text-sm italic">Pensando…</div></div>';
    chat.appendChild(placeholder);
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;

    generating = true;
    followBottom = true;
    setSendingUI(true);
    generation = { stop: false, controller: null };

    const target = placeholder.querySelector('.stream-target');
    let acc = '';
    let remoteUsage = { input_tokens: 0, output_tokens: 0 };
    let lastRender = 0;

    let stopped = false;
    try {
      const onDelta = (full, throttleMs) => {
        acc = full;
        const now = performance.now();
        if (now - lastRender > throttleMs) {
          target.innerHTML = renderMarkdown(full) + '<span class="stream-caret"></span>';
          lastRender = now;
          if (followBottom) $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
        }
      };
      try {
        if (activeProvider() === 'backend') {
          const ctrl = new AbortController();
          generation.controller = ctrl;
          const out = await window.OrbitBackend.streamChat({
            workspace_id: state.backend.workspaceId,
            conversation_id: convo.remoteId || null,
            agent_id: state.backend.agentId,
            provider_credential_id: state.provider.credentialId || null,
            content: text,
          }, (name, payload) => {
            if (name === 'meta' && payload.conversation_id) convo.remoteId = payload.conversation_id;
            if (name === 'token') onDelta(payload.content || acc, 60);
          }, ctrl.signal);
          acc = out.content || acc;
          remoteUsage = out.usage || remoteUsage;
          state.provider.model = out.model || state.provider.model;
        } else {
          throw new ProviderError('O backend do Orbit não está autenticado.', 401);
        }
      } catch (e) {
        if (e instanceof StopError || generation.stop || e.name === 'AbortError') stopped = true;
        else throw e;
      }
      if (stopped) acc += '\n\n---\n*Geração interrompida — use **Continuar** para retomar.*';

      // Finaliza a mensagem
      const model = state.provider.model || state.model || 'modelo configurado no backend';
      const asstMsg = { role: 'assistant', content: acc, model: model, ts: Date.now(), thinking: 'Resposta gerada pelo provedor configurado no backend.', usage: { input: remoteUsage.input_tokens || 0, output: remoteUsage.output_tokens || 0 } };
      convo.messages.push(asstMsg);
      const rate = (MODELS.find((m2) => m2.id === model)?.rate || 1000);
      state.tokens.used += asstMsg.usage.input + asstMsg.usage.output;
      convo.updatedAt = Date.now();
      saveState();

      // Substitui o placeholder pela mensagem final
      placeholder.querySelector('.prose').classList.remove('stream-target', 'text-app-text', 'italic');
      placeholder.querySelector('.typing-dots')?.remove();
      placeholder.querySelector('.prose').innerHTML = renderMarkdown(asstMsg.content);
      rerenderAll();
    } catch (e) {
      if (e instanceof StopError || generation.stop) {
        // interrupção manual: não vira mensagem salva; usuário pode usar "Continuar"
      } else if (e instanceof ProviderError || e instanceof Error) {
        placeholder.querySelector('.prose').innerHTML =
          '<div class="border border-app-red/30 bg-app-red/10 rounded-lg p-3 text-sm text-app-red">' +
          '<div><i class="ph ph-warning-circle mr-1.5"></i>Falha no backend (' + (e.status || 0) + '): ' + escapeHtml(e.message) + '</div>' +
          '<div class="text-xs text-app-text mt-1.5">Verifique Base URL, modelo e chave em Configurações. Se for bloqueio de CORS, execute o app em um servidor local.</div>' +
          '<button data-act="regen" class="mt-2.5 text-xs text-app-textLight bg-white/5 hover:bg-white/10 border border-app-border rounded-md px-3 py-1.5 transition-colors"><i class="ph ph-arrow-counter-clockwise mr-1"></i>Tentar novamente</button></div>';
        toast('Falha ao chamar a API: ' + e.message, 'error');
      } else {
        placeholder.querySelector('.prose').innerHTML =
          '<div class="border border-app-red/30 bg-app-red/10 rounded-lg p-3 text-sm text-app-red">' +
          '<div><i class="ph ph-warning-circle mr-1.5"></i>Erro inesperado: ' + escapeHtml(e.message) + '</div>' +
          '<button data-act="regen" class="mt-2.5 text-xs text-app-textLight bg-white/5 hover:bg-white/10 border border-app-border rounded-md px-3 py-1.5 transition-colors"><i class="ph ph-arrow-counter-clockwise mr-1"></i>Tentar novamente</button></div>';
      }
    } finally {
      generating = false;
      setSendingUI(false);
      updateToBottomBtn();
      renderUsagePanel();
    }
  }

  let generating = false;
  function setSendingUI(on) {
    $('#btnSend').classList.toggle('hidden', on);
    $('#btnStop').classList.toggle('hidden', !on);
  }

  let followBottom = true;
  function isNearBottom() {
    const el = $('#chatScroll');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }
  function updateToBottomBtn() {
    const btn = $('#btnToBottom');
    if (btn) btn.classList.toggle('hidden', !generating || isNearBottom());
  }
  function syncSendState() {
    const empty = !$('#input').value.trim();
    const btn = $('#btnSend');
    btn.classList.toggle('opacity-40', empty);
    btn.classList.toggle('pointer-events-none', empty);
  }

  /* Regenerar: remove a última resposta e reenvia */
  async function regenerate() {
    const convo = activeConvo();
    if (!convo || generating) return;
    let i = convo.messages.length - 1;
    while (i >= 0 && convo.messages[i].role !== 'user') i--;
    if (i < 0) return;
    const lastUser = convo.messages[i].content;
    convo.messages = convo.messages.slice(0, i + 1);
    saveState();
    renderChat(false);
    await sendMessage(lastUser);
  }

  function continueChat() {
    if (generating) return;
    sendMessage('Continue de onde parou e aprofunde o próximo ponto.');
  }

  /* ----------------------------------------------------------
     UI: eventos
  ---------------------------------------------------------- */
  function bindEvents() {
    // Entrada
    const input = $('#input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 144) + 'px';
      const est = Math.max(40, Math.round(input.value.length / 4) + 40);
      $('#tokenEstimate').textContent = '~ ' + est + ' tokens';
      syncSendState();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    $('#btnSend').addEventListener('click', doSend);
    syncSendState();
    $('#btnStop').addEventListener('click', () => {
      if (generating) { generation.stop = true; if (generation.controller) generation.controller.abort(); }
    });

    // Seguinte: auto-scroll na geração e botão "ir para o fim"
    const chatScrollEl = $('#chatScroll');
    chatScrollEl.addEventListener('scroll', () => { followBottom = isNearBottom(); updateToBottomBtn(); });
    $('#btnToBottom').addEventListener('click', () => {
      followBottom = true;
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
      updateToBottomBtn();
    });

    // Sugestões / chips
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-suggest]');
      if (chip) { const i = +chip.dataset.suggest; input.value = SUGGESTIONS[i]; input.dispatchEvent(new Event('input')); input.focus(); return; }

      // Cópia em bloco de código
      const copy = e.target.closest('.copy-code');
      if (copy) {
        const code = copy.closest('.code-block').querySelector('pre').innerText;
        navigator.clipboard.writeText(code).then(() => toast('Código copiado.'), () => toast('Não foi possível copiar.', 'warn'));
        return;
      }

      // Toggles de raciocínio ("Pensamento resumido")
      const think = e.target.closest('.think-toggle');
      if (think) {
        const body = think.parentElement.querySelector('.think-body');
        const caret = think.querySelector('.ph-caret-down');
        if (body) {
          const hidden = body.classList.toggle('hidden');
          if (caret) caret.style.transform = hidden ? 'rotate(0deg)' : 'rotate(180deg)';
        }
        return;
      }

      // Ações de mensagem — mapeia o clique para a mensagem exata pelo index no DOM
      const act = e.target.closest('[data-act]');
      if (act) {
        const convo = activeConvo();
        const a = act.dataset.act;
        // Para retry de erro (placeholder), o índice não existe: cai em "regen"
        const wrapper = act.closest('.msg-enter');
        const idx = wrapper ? Array.from($('#chat').children).indexOf(wrapper) : -1;
        const msg = idx >= 0 && convo ? convo.messages[idx] : null;
        if (a === 'copy' && msg) {
          navigator.clipboard.writeText(msg.content).then(() => toast('Mensagem copiada.'), () => toast('Não foi possível copiar.', 'warn'));
        } else if ((a === 'like' || a === 'dislike') && msg) {
          msg.feedback = a === 'like' ? (msg.feedback === 1 ? 0 : 1) : (msg.feedback === -1 ? 0 : -1);
          saveState();
          rerenderAll();
          toast(a === 'like' ? 'Obrigado pelo feedback!' : 'Anotado — vamos melhorar.', 'info');
        } else if (a === 'regen') { regenerate(); }
        else if (a === 'continue') { continueChat(); }
        return;
      }

      // Menus
      const modelItem = e.target.closest('[data-model]:not(.model-row)');
      if (modelItem) {
        state.model = modelItem.dataset.model;
        saveState();
        renderModelMenu();
        $('#modelMenu').classList.add('hidden');
        return;
      }
      const wsItem = e.target.closest('[data-ws]');
      if (wsItem) {
        state.workspace = wsItem.dataset.ws;
        saveState();
        renderWorkspace();
        $('#wsMenu').classList.add('hidden');
        toast('Workspace alterado para ' + state.workspace + '.');
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteConvo(del.dataset.del); return; }
      const conv = e.target.closest('.conv-item');
      if (conv) { state.activeId = conv.dataset.id; saveState(); rerenderAll(); closeDrawers(); return; }

      const more = e.target.closest('[data-more]');
      if (more) {
        const t = more.dataset.more;
        $('#moreMenu').classList.add('hidden');
        if (t === 'copy') copyConvo();
        if (t === 'export') exportConvo();
        if (t === 'clear') clearConvo();
        return;
      }
      const acct = e.target.closest('[data-acct]');
      if (acct) {
        $('#accountPopover').classList.add('hidden');
        const a = acct.dataset.acct;
        if (a === 'prefs') openSettings();
        else if (a === 'perfil') openProfileModal();
        else if (a === 'billing') openBillingModal();
        else if (a === 'logout') logoutAccount();
        return;
      }
    });

    // Toggles de menus
    $('#modelBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#modelMenu')); });
    $('#wsButton').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#wsMenu');
      const open = !menu.classList.contains('hidden');
      closeAllMenus();
      if (!open) { menu.classList.remove('hidden'); $('#wsCaret').style.transform = 'rotate(180deg)'; } else { $('#wsCaret').style.transform = ''; }
    });
    $('#accountBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.backend?.workspaceId) { openAuth(); return; }
      const pop = $('#accountPopover');
      const open = !pop.classList.contains('hidden');
      closeAllMenus();
      if (!open) { pop.classList.remove('hidden'); $('#accountCaret').style.transform = 'rotate(180deg)'; } else { $('#accountCaret').style.transform = ''; }
    });
    $('#btnMore').addEventListener('click', (e) => { e.stopPropagation(); closeAllMenus(); $('#moreMenu').classList.toggle('hidden'); });
    $('#btnExport').addEventListener('click', exportConvo);
    $('#btnShare').addEventListener('click', copyConvo);

    // Conversas
    $('#btnNewChat').addEventListener('click', newConversation);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newConversation(); }
      if (e.key === 'Escape') { closeAllMenus(); closeSettings(); closeDrawers(); }
    });
    $('#searchToggle').addEventListener('click', () => {
      const w = $('#searchWrap');
      w.classList.toggle('hidden');
      if (!w.classList.contains('hidden')) $('#searchInput').focus();
    });
    $('#searchInput').addEventListener('input', renderSidebar);

    // Right panel
    document.addEventListener('click', (e) => {
      const mr = e.target.closest('[data-model].model-row');
      if (mr) { state.model = mr.dataset.model; saveState(); renderModelMenu(); renderUsagePanel(); }
    });
    $('#btnPanelRight').addEventListener('click', () => {
      const aside = $('#rightSidebar');
      if (window.matchMedia('(min-width: 1024px)').matches) aside.classList.toggle('collapsed');
      else { aside.classList.add('open'); showBackdrop(true, 'right'); }
    });
    $('#btnMenuLeft').addEventListener('click', () => {
      $('#leftSidebar').classList.add('open'); showBackdrop(true, 'left');
    });
    $('#backdrop').addEventListener('click', closeDrawers);

    // Navegação
    $('#navAgents').addEventListener('click', openAgents);
    $('#agentsClose')?.addEventListener('click', closeAgents);
    $('#agentsModal')?.addEventListener('click', (e) => { if (e.target.id === 'agentsModal' || e.target.classList.contains('modal-backdrop')) closeAgents(); });
    $('#agentsList')?.addEventListener('click', (e) => { const item = e.target.closest('[data-agent-id]'); if (!item) return; state.backend.agentId = item.dataset.agentId; saveState(); closeAgents(); toast('Agente selecionado.', 'success'); });
    $('#agentForm')?.addEventListener('submit', createAgentFromForm);
    const creditNav = $('#navCredits');
    creditNav.addEventListener('click', () => {
      const panel = $('#rightSidebar');
      if (!window.matchMedia('(min-width: 1024px)').matches) {
        panel.classList.add('open');
        showBackdrop(true, 'right');
        return;
      }
      panel.classList.remove('collapsed');
      panel.classList.remove('panel-flash');
      void panel.offsetWidth;
      panel.classList.add('panel-flash');
      setTimeout(() => panel.classList.remove('panel-flash'), 1000);
    });
    $('#navSettings').addEventListener('click', openSettings);
    $('#btnManageModels').addEventListener('click', openSettings);
    $('#btnUsageDetails').addEventListener('click', openBillingModal);

    // Painel à direita: botão de fechar (colapsa no desktop, fecha o drawer no mobile)
    $('#rightClose').addEventListener('click', () => {
      if (window.matchMedia('(min-width: 1024px)').matches) $('#rightSidebar').classList.add('collapsed');
      else closeDrawers();
    });

    // Modais de perfil e cobrança: X, backdrop ou Esc
    ['profileModal', 'billingModal'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('click', (e) => {
        if (e.target.id === id || e.target.classList.contains('modal-backdrop') || e.target.closest('[data-close="' + id + '"]')) closeModal(id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#billingModal').classList.contains('hidden')) closeModal('billingModal');
        else if (!$('#profileModal').classList.contains('hidden')) closeModal('profileModal');
        else if (!$('#settingsModal').classList.contains('hidden')) closeSettings();
        else if (!$('#agentsModal').classList.contains('hidden')) closeAgents();
      }
    });

    // Configurações
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal' || e.target.classList.contains('modal-backdrop')) closeSettings(); });
    $$('input[name="providerMode"]').forEach((r) => r.addEventListener('change', syncProviderUI));
    $('#keyToggle').addEventListener('click', () => {
      const k = $('#apiKey');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('#keyToggle').textContent = k.type === 'password' ? 'mostrar' : 'ocultar';
    });
    $('#btnTestApi').addEventListener('click', testApi);
    $('#authForm')?.addEventListener('submit', (e) => { e.preventDefault(); authenticate('signin'); });
    $('#authSignUp')?.addEventListener('click', () => authenticate('signup'));
    $('#authModal')?.addEventListener('click', (e) => { if (e.target.id === 'authModal' || e.target.classList.contains('modal-backdrop')) closeAuth(); });
    $('#settingsSave').addEventListener('click', saveSettings);
    $('#btnResetDemo').addEventListener('click', () => { if (confirm('Limpar o estado local deste navegador?')) { state = { ...seedState() }; saveState(); rerenderAll(); toast('Estado local limpo.'); closeSettings(); } });
    $('#btnClearData').addEventListener('click', () => {
      if (confirm('Apagar todas as conversas e dados locais?')) { localStorage.removeItem(STORAGE_KEY); location.reload(); }
    });

    // Botões que ainda estão "em breve"
    $('#btnAttach').addEventListener('click', () => toast('Anexação de arquivos chega em breve.', 'info'));
    $('#btnMic').addEventListener('click', () => toast('Ditado por voz chega em breve.', 'info'));
  }

  function doSend() { const v = $('#input').value; if (!v.trim() || generating) return; $('#input').value = ''; $('#input').style.height = 'auto'; syncSendState(); sendMessage(v); }

  function newConversation() {
    state.activeId = null;
    saveState();
    rerenderAll();
    closeDrawers();
    $('#input').focus();
  }

  function deleteConvo(id) {
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    if (!confirm('Excluir a conversa "' + conv.title + '"?')) return;
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (state.activeId === id) state.activeId = state.conversations[0]?.id || null;
    saveState();
    rerenderAll();
    toast('Conversa excluída.');
  }

  function clearConvo() {
    const c = activeConvo();
    if (!c) return;
    if (!confirm('Limpar as mensagens desta conversa?')) return;
    c.messages = [];
    c.title = 'Nova conversa';
    c.updatedAt = Date.now();
    saveState();
    rerenderAll();
    toast('Conversa limpa.');
  }

  function convoToMarkdown(c) {
    let out = '# ' + c.title + '\n\n';
    c.messages.forEach((m) => { out += (m.role === 'user' ? '## Você\n\n' : '## Devin\n\n') + m.content + '\n\n---\n\n'; });
    return out;
  }
  function copyConvo() {
    const c = activeConvo();
    if (!c) { toast('Nada para copiar.', 'warn'); return; }
    navigator.clipboard.writeText(convoToMarkdown(c)).then(() => toast('Conversa copiada.'), () => toast('Não foi possível copiar.', 'warn'));
  }
  function exportConvo() {
    const c = activeConvo();
    if (!c) { toast('Nada para exportar.', 'warn'); return; }
    const blob = new Blob([convoToMarkdown(c)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = c.title.replace(/[^a-z0-9-]+/gi, '_').toLowerCase() + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exportado como .md');
  }

  function toggleMenu(el) { const willOpen = el.classList.contains('hidden'); closeAllMenus(); if (willOpen) el.classList.remove('hidden'); }
  function closeAllMenus() {
    ['wsMenu', 'modelMenu', 'moreMenu', 'accountPopover'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    $('#wsCaret') && ($('#wsCaret').style.transform = '');
    $('#accountCaret') && ($('#accountCaret').style.transform = '');
  }

  // Drawers mobile
  function showBackdrop(on, side) {
    const b = $('#backdrop');
    b.classList.toggle('hidden', !on);
    b.dataset.side = side || '';
  }
  function closeDrawers() {
    $('#leftSidebar').classList.remove('open');
    $('#rightSidebar').classList.remove('open');
    $('#backdrop').classList.add('hidden');
  }

  /* ----------------------------------------------------------
     Configurações / Provider
  ---------------------------------------------------------- */
  function syncProviderUI() {
    const fields = $('#apiFields');
    fields.classList.remove('opacity-40', 'pointer-events-none');
    $('.mode-check').forEach((i) => i.classList.add('hidden'));
    document.querySelector('label[data-mode="backend"] .mode-check')?.classList.remove('hidden');
  }
  function openSettings() {
    closeAllMenus();
    const p = state.provider;
    $('#settingsModal input[name="providerMode"]').forEach((radio) => { radio.checked = radio.value === 'backend'; });
    $('#apiUrl').value = p.baseUrl || '';
    $('#apiModel').value = p.model || '';
    $('#apiKey').value = '';
    $('#apiStatus').textContent = '';
    syncProviderUI();
    const m = $('#settingsModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
  function closeSettings() {
    const m = $('#settingsModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  /* ----------------------------------------------------------
     Modais: perfil e cobrança
  ---------------------------------------------------------- */
  function openModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  function creditInfo() {
    const used = state.tokens.used;
    const remaining = Math.max(0, CREDIT_TOTAL - used);
    const pct = Math.min(100, Math.round((remaining / CREDIT_TOTAL) * 100));
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthName = now.toLocaleDateString('pt-BR', { month: 'long' });
    const daysLeft = lastDay - now.getDate();
    return {
      used: used,
      remaining: remaining,
      pct: pct,
      cycle: '1–' + lastDay + ' de ' + monthName,
      renew: daysLeft <= 0 ? 'Renova hoje' : daysLeft === 1 ? 'Renova em 1 dia' : 'Renova em ' + daysLeft + ' dias',
    };
  }

  function usageBreakdownData() {
    const byModel = {};
    state.conversations.forEach((c) => c.messages.forEach((m) => {
      if (m.role === 'assistant' && m.usage) byModel[m.model] = (byModel[m.model] || 0) + m.usage.input + m.usage.output;
    }));
    const modelsTokens = Object.values(byModel).reduce((a, b) => a + b, 0);
    const tools = 0, storage = 0;
    return { modelsTokens: modelsTokens, tools: tools, storage: storage, total: modelsTokens + tools + storage };
  }

  function providerLabel() {
    const p = state.provider;
    if (activeProvider() === 'backend') return 'Orbit Backend — ' + (p.model || 'modelo configurado');
    return 'Login necessário';
  }

  function billingSummaryText() {
    const info = creditInfo();
    const b = usageBreakdownData();
    return [
      'OrbitAI — Resumo de cobrança',
      'Plano: Equipe Pro (' + CREDIT_TOTAL.toLocaleString('pt-BR') + ' tokens por ciclo)',
      'Ciclo: ' + info.cycle + ' · ' + info.renew,
      'Tokens restantes: ' + info.remaining.toLocaleString('pt-BR') + ' (' + info.pct + '%)',
      'Consumo — Modelos: ' + b.modelsTokens.toLocaleString('pt-BR') + ' · Ferramentas: ' + b.tools.toLocaleString('pt-BR') + ' · Armazenamento: ' + b.storage.toLocaleString('pt-BR') + ' · Total: ' + b.total.toLocaleString('pt-BR'),
    ].join('\n');
  }

  function openProfileModal() {
    closeAllMenus();
    const info = creditInfo();
    const model = MODELS.find((mm) => mm.id === state.model);
    $('#profileBody').innerHTML =
      '<div class="flex items-center gap-3">' +
      '<div class="w-11 h-11 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-medium text-sm border border-purple-500/30">LO</div>' +
      '<div class="min-w-0">' +
      '<div class="text-sm font-medium text-app-textLight">Conta OrbitAI <span class="text-app-text font-normal">· autenticada</span></div>' +
      '<div class="text-xs text-app-text mt-0.5">Workspace: ' + escapeHtml(state.workspace || '—') + '</div>' +
      '</div></div>' +
      '<div class="rounded-xl border border-app-border bg-white/[0.03] p-3.5 space-y-2.5 text-xs">' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Plano</span><span class="text-app-textLight">Equipe Pro</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Ciclo atual</span><span class="text-app-textLight">' + info.cycle + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Tokens restantes</span><span class="text-app-textLight font-mono">' + formatNumber(info.remaining) + ' <span class="text-app-text">(' + info.pct + '%)</span></span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Renovação</span><span class="text-app-textLight">' + info.renew + '</span></div>' +
      '<div class="flex items-center justify-between gap-3"><span class="text-app-text shrink-0">Provedor ativo</span><span class="text-app-textLight text-right min-w-0 truncate">' + escapeHtml(providerLabel()) + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Modelo</span><span class="text-app-textLight">' + escapeHtml(model ? model.name : (state.model || '—')) + '</span></div>' +
      '</div>' +
      '<div class="flex gap-2 pt-1">' +
      '<button id="profileOpenSettings" class="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-border bg-white/5 text-xs text-app-textLight hover:bg-white/10 transition-colors"><i class="ph ph-faders"></i> Provedor e dados</button>' +
      '<button id="profileLogout" class="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-red/30 bg-app-red/10 text-xs text-app-red hover:bg-app-red/20 transition-colors"><i class="ph ph-sign-out"></i> Sair</button>' +
      '</div>';
    $('#profileOpenSettings').addEventListener('click', () => { closeModal('profileModal'); openSettings(); });
    $('#profileLogout').addEventListener('click', () => { closeModal('profileModal'); logoutAccount(); });
    openModal('profileModal');
  }

  function downloadBillingReport() {
    const md = [
      '# OrbitAI — Relatório de cobrança',
      '',
      billingSummaryText(),
      '',
      '---',
      'Gerado em ' + new Date().toLocaleString('pt-BR'),
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orbitai-relatorio-' + new Date().toISOString().slice(0, 10) + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Relatório .md exportado.');
  }

  function openBillingModal() {
    closeAllMenus();
    const info = creditInfo();
    const b = usageBreakdownData();
    $('#billingBody').innerHTML =
      '<div class="rounded-xl border border-app-accent/30 bg-app-accent/10 p-3.5 text-xs space-y-1.5">' +
      '<div class="flex items-center gap-2 text-app-textLight font-medium"><i class="ph ph-rocket text-app-accent"></i> Plano Equipe Pro — ' + formatNumber(CREDIT_TOTAL) + ' tokens por ciclo</div>' +
      '<div class="text-app-text">' + info.cycle + ' · ' + info.renew + '</div>' +
      '<div class="text-app-text">Restam <span class="text-app-textLight font-mono">' + formatNumber(info.remaining) + ' tokens</span> (' + info.pct + '%).</div>' +
      '</div>' +
      '<div class="rounded-xl border border-app-border bg-white/[0.03] p-3.5 text-xs space-y-2">' +
      '<div class="font-medium text-app-textLight">Consumo do ciclo</div>' +
      '<div class="flex justify-between"><span class="text-app-text">Modelos</span><span class="font-mono">' + formatNumber(b.modelsTokens) + '</span></div>' +
      '<div class="flex justify-between"><span class="text-app-text">Ferramentas</span><span class="font-mono">' + formatNumber(b.tools) + '</span></div>' +
      '<div class="flex justify-between"><span class="text-app-text">Armazenamento</span><span class="font-mono">' + formatNumber(b.storage) + '</span></div>' +
      '<div class="flex justify-between border-t border-app-border pt-2 font-medium"><span>Total</span><span class="font-mono">' + formatNumber(b.total) + '</span></div>' +
      '</div>' +
      '<div class="text-[10px] text-app-text">Valores estimados em R$/1M de tokens de entrada, apenas referência.</div>' +
      '<div class="flex gap-2 pt-1">' +
      '<button id="billingDownload" class="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-accent/40 bg-app-accent/10 text-xs text-app-accent hover:bg-app-accent/20 transition-colors"><i class="ph ph-download"></i> Baixar relatório (.md)</button>' +
      '<button id="billingCopy" class="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-border bg-white/5 text-xs text-app-textLight hover:bg-white/10 transition-colors"><i class="ph ph-copy"></i> Copiar resumo</button>' +
      '</div>';
    $('#billingDownload').addEventListener('click', downloadBillingReport);
    $('#billingCopy').addEventListener('click', () => {
      navigator.clipboard.writeText(billingSummaryText()).then(() => toast('Resumo copiado.'), () => toast('Não foi possível copiar.', 'warn'));
    });
    openModal('billingModal');
  }

  async function logoutAccount() {
    if (!confirm('Encerrar sua sessão do OrbitAI?')) return;
    await window.OrbitBackend?.signOut();
    state.backend = { workspaceId: null, agentId: null, providerId: null };
    saveState();
    rerenderAll();
    openAuth();
  }
  async function saveSettings() {
    if (!window.OrbitBackend?.configured || !state.backend?.workspaceId) {
      openAuth();
      return;
    }
    const baseUrl = $('#apiUrl').value.trim();
    const model = $('#apiModel').value.trim();
    const apiKey = $('#apiKey').value.trim();
    if (!baseUrl || !model || !apiKey) {
      toast('Informe URL, modelo e chave do provedor.', 'warn');
      return;
    }
    let provider = 'openai-compatible';
    if (/anthropic\.com/i.test(baseUrl)) provider = 'anthropic';
    else if (/openrouter/i.test(baseUrl)) provider = 'openrouter';
    else if (/localhost|127\.0\.0\.1/i.test(baseUrl)) provider = 'sglang';
    try {
      const result = await window.OrbitBackend.saveProvider({
        workspace_id: state.backend.workspaceId,
        provider,
        base_url: baseUrl,
        model,
        api_key: apiKey,
        label: 'Principal',
      });
      state.provider = { mode: 'backend', baseUrl, model, apiKey: '', credentialId: result.provider?.id || null };
      state.model = 'configured';
      saveState();
      renderModelMenu();
      closeSettings();
      toast('Provedor salvo com criptografia no backend.', 'success');
    } catch (error) {
      toast('Não foi possível salvar o provedor: ' + (error.message || 'erro desconhecido'), 'error');
    }
  }
  async function testApi() {
    $('#apiStatus').textContent = 'A validação ocorre ao salvar e na primeira geração.';
    $('#apiStatus').className = 'text-[11px] text-app-text';
  }

  /* ----------------------------------------------------------
     Toast
  ---------------------------------------------------------- */
  let toastSeq = 0;
  window.toast = function toast(msg, type) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.textContent = msg;
    box.appendChild(t);
    const id = ++toastSeq;
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 300);
    }, 3200);
  };

  /* ----------------------------------------------------------
     Preloader
  ---------------------------------------------------------- */
  function runPreloader() {
    const pre = $('#preloader');
    const bar = $('#loading-bar');
    if (reducedMotion) { pre.style.display = 'none'; return; }
    const t1 = setTimeout(() => { bar.style.width = '35%'; }, 250);
    const t2 = setTimeout(() => { bar.style.width = '78%'; }, 900);
    const t3 = setTimeout(() => {
      bar.style.width = '100%';
      pre.style.transition = 'opacity 0.5s ease, visibility 0.5s ease';
      pre.style.opacity = '0';
      pre.style.visibility = 'hidden';
      setTimeout(() => { pre.style.display = 'none'; }, 500);
    }, 1500);
  }

  /* ----------------------------------------------------------
     Init
  ---------------------------------------------------------- */
  function init() {
    bindEvents();
    rerenderAll();
    runPreloader();
    if (window.OrbitBackend?.configured) {
      window.OrbitBackend.onAuthStateChange(() => { setTimeout(syncBackendAccount, 0); });
    }
    syncBackendAccount();
  }

  document.addEventListener('DOMContentLoaded', init);
  // Garante foco no input
  window.addEventListener('load', () => { setTimeout(() => $('#input').focus(), 400); });
})();
