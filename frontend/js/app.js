/* ============================================================
   OrbitAI — app.js
   UI + estado, integrado ao backend real (Supabase).
   Depende de: js/config.js, js/db.js (window.OrbitDB),
   supabase-js UMD (window.supabase).
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DB = window.OrbitDB;

  const SUGGESTIONS = [
    'Crie um plano de lançamento para meu SaaS',
    'Me ajude a refatorar um endpoint REST',
    'Explique React Server Components',
    'Compare Vite e Webpack para meu monorepo',
  ];
  const CREDIT_TOTAL = 10000; // deve bater com o default de profiles.credits

  /* ----------------------------------------------------------
     Estado
  ---------------------------------------------------------- */
  let session = null;
  let profile = null;
  let models = [];
  let agents = [];
  let conversations = [];
  let activeId = null;
  let activeMessages = [];
  let activeAgentId = null;   // agente selecionado p/ novas conversas
  let selectedModel = null;   // modelo selecionado
  let pendingAttachments = [];
  let generating = false;
  let generation = { controller: null };

  /* ----------------------------------------------------------
     Utilitários
  ---------------------------------------------------------- */
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function relTime(ts) {
    const diff = Date.now() - new Date(ts).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.floor(h / 24);
    if (d === 1) return 'ontem';
    return d + ' dias';
  }
  function formatNumber(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function initials(name) {
    return (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  /* Markdown leve: código, listas, títulos, negrito, itálico, inline, links */
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
     Toast
  ---------------------------------------------------------- */
  window.toast = function toast(msg, type) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
  };

  /* ----------------------------------------------------------
     Lookups
  ---------------------------------------------------------- */
  function modelById(id) { return models.find((m) => m.id === id) || null; }
  function agentById(id) { return agents.find((a) => a.id === id) || null; }
  function activeConvo() { return conversations.find((c) => c.id === activeId) || null; }
  function convoAgent(convo) {
    if (convo && convo.agent_id && agentById(convo.agent_id)) return agentById(convo.agent_id);
    if (activeAgentId && agentById(activeAgentId)) return agentById(activeAgentId);
    return agents.find((a) => a.name === 'Orbit') || agents[0] || null;
  }

  /* ----------------------------------------------------------
     Renderização
  ---------------------------------------------------------- */
  function renderSidebar() {
    const list = $('#convList');
    const q = ($('#searchInput').value || '').trim().toLowerCase();
    const items = conversations.filter((c) => !q || c.title.toLowerCase().includes(q));
    list.innerHTML = items.map((c) => {
      const active = c.id === activeId;
      return (
        '<button class="conv-item group w-full flex items-center justify-between px-2.5 py-2 rounded-md ' +
        (active ? 'bg-white/10 text-app-textLight' : 'hover:bg-white/5 text-app-text hover:text-app-textLight') +
        ' text-sm transition-colors" data-id="' + c.id + '">' +
        '<span class="flex items-center gap-2 truncate"><i class="ph ph-chat-teardrop-text"></i> ' + escapeHtml(c.title) + '</span>' +
        '<span class="flex items-center gap-2 flex-shrink-0">' +
        '<span class="text-[10px] text-app-text">' + relTime(c.updated_at) + '</span>' +
        (active ? '<span class="w-1.5 h-1.5 rounded-full bg-app-accent"></span>' :
          '<i class="ph ph-trash text-[11px] text-app-text/40 group-hover:text-app-red hidden group-hover:inline" data-del="' + c.id + '" aria-label="Excluir conversa"></i>') +
        '</span></button>'
      );
    }).join('');
    if (!items.length) list.innerHTML = '<div class="text-xs text-app-text px-2 py-4 text-center">Nenhuma conversa ainda.</div>';
  }

  function msgEl(m, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    if (m.role === 'user') {
      const atts = (m.attachments || []).map((a) =>
        '<span class="inline-flex items-center gap-1 text-[10px] bg-white/10 rounded px-1.5 py-0.5 mr-1"><i class="ph ph-paperclip"></i>' + escapeHtml(a.name || 'arquivo') + '</span>').join('');
      wrap.className = 'flex flex-col items-end gap-1 msg-enter';
      wrap.innerHTML =
        '<div class="text-xs text-app-text mr-1">' + relTime(m.created_at || Date.now()) + ' <span class="bg-white/10 w-5 h-5 inline-flex items-center justify-center rounded-full ml-2 text-[10px] text-white">' + escapeHtml(initials(profile?.full_name)) + '</span></div>' +
        '<div class="bg-app-panel border border-app-border text-app-textLight px-4 py-3 rounded-2xl rounded-tr-sm max-w-2xl text-sm leading-relaxed shadow-lg whitespace-pre-wrap">' + (atts ? '<div class="mb-1.5">' + atts + '</div>' : '') + escapeHtml(m.content) + '</div>';
      return wrap;
    }
    const modelInfo = modelById(m.model);
    const modelLabel = modelInfo ? modelInfo.name : (m.model || 'Modelo');
    const agent = convoAgent(activeConvo());
    wrap.className = 'flex gap-4 max-w-4xl msg-enter';
    const avatar = document.createElement('div');
    avatar.className = 'w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-app-textLight flex-shrink-0 mt-1';
    avatar.innerHTML = '<i class="ph-fill ' + escapeHtml(agent?.icon || 'ph-robot') + ' text-lg"></i>';
    const content = document.createElement('div');
    content.className = 'flex-1 min-w-0';
    content.innerHTML =
      '<div class="flex items-center gap-2 text-xs text-app-text mb-2 flex-wrap">' +
      '<span class="font-medium text-app-textLight">' + escapeHtml(agent?.name || 'Orbit') + '</span>' +
      '<span class="bg-white/5 border border-white/10 rounded-full px-2 py-0.5 leading-none">' + escapeHtml(modelLabel) + '</span>' +
      '<span>' + relTime(m.created_at || Date.now()) + '</span></div>' +
      '<div class="prose">' + renderMarkdown(m.content) + '</div>';

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
        (m.usage ? '<span class="ml-auto text-[10px] text-app-text font-mono">' + formatNumber(m.usage.input + m.usage.output) + ' tokens</span>' : ''));
    content.appendChild(actions);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    return wrap;
  }

  function renderChat(animate) {
    const chat = $('#chat');
    const chatScroll = $('#chatScroll');
    chat.innerHTML = '';
    const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
    if (!activeMessages.length) {
      $('#emptyState').classList.remove('hidden');
      renderSuggestions();
      return;
    }
    $('#emptyState').classList.add('hidden');
    activeMessages.forEach((m, i) => {
      const el = msgEl(m, { isLast: i === activeMessages.length - 1 });
      if (animate && !reducedMotion) el.style.animationDelay = Math.min(i * 80, 400) + 'ms';
      chat.appendChild(el);
    });
    if (nearBottom || animate) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function renderSuggestions() {
    $('#suggestChips').innerHTML = SUGGESTIONS.map((s, i) =>
      '<button data-suggest="' + i + '" style="animation-delay:' + (i * 70) + 'ms" class="chip animate-fade-in px-3 py-2 rounded-full border border-app-border bg-white/[0.03] hover:bg-white/10 hover:border-app-accent/40 text-xs text-app-text hover:text-app-textLight transition-all active:scale-95">' +
      '<i class="ph ph-lightbulb text-app-accent mr-1.5"></i>' + escapeHtml(s) + '</button>'
    ).join('');
  }

  async function renderUsagePanel() {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthName = now.toLocaleDateString('pt-BR', { month: 'long' });
    $('#cycleLabel').textContent = '1–' + lastDay + ' de ' + monthName;
    const daysLeft = lastDay - now.getDate();
    $('#renewLabel').textContent = daysLeft <= 0 ? 'Renova hoje' : daysLeft === 1 ? 'Renova em 1 dia' : 'Renova em ' + daysLeft + ' dias';

    try { profile = await DB.getProfile(); } catch (e) { /* mantém cache */ }
    const remaining = Math.max(0, profile ? profile.credits : 0);
    const pct = Math.min(100, Math.round((remaining / CREDIT_TOTAL) * 100));
    $('#creditsNum').textContent = formatNumber(remaining);
    $('#creditsTotal').textContent = formatNumber(CREDIT_TOTAL);
    $('#creditsPct').textContent = pct + '%';
    const bar = document.querySelector('.credit-bar');
    bar.style.width = pct + '%';
    bar.classList.toggle('is-critical', pct < 10);
    bar.classList.toggle('is-low', pct >= 10 && pct < 30);
    $('#creditsLow').classList.toggle('hidden', pct >= 30);

    // Consumo real por modelo (usage_events)
    let events = [];
    try { events = await DB.usageSummary(); } catch (e) { /* ignore */ }
    const byModel = {};
    events.forEach((ev) => { byModel[ev.model] = (byModel[ev.model] || 0) + ev.tokens_in + ev.tokens_out; });
    const rows = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
    const colors = ['#c0ff2d', '#3b82f6', '#a855f7', '#f59e0b', '#14b8a6', '#f43f5e'];
    $('#usageBreakdown').innerHTML = rows.length
      ? rows.map(([mid, tok], i) => {
          const name = modelById(mid)?.name || mid || 'modelo';
          const c = colors[i % colors.length];
          return '<div class="flex items-center justify-between text-xs">' +
            '<div class="flex items-center gap-2 text-app-textLight"><span class="w-2 h-2 rounded-full" style="background:' + c + ';box-shadow:0 0 5px ' + c + '80"></span> ' + escapeHtml(name) + '</div>' +
            '<span class="text-app-text font-mono">' + formatNumber(tok) + '</span></div>';
        }).join('') +
        '<div class="pt-2 border-t border-white/10 flex items-center justify-between text-xs font-medium text-app-textLight mt-1"><span>Total</span><span class="font-mono">' + formatNumber(rows.reduce((a, r) => a + r[1], 0)) + '</span></div>'
      : '<div class="text-xs text-app-text">Sem consumo neste ciclo.</div>';

    $('#modelList').innerHTML = models.map((m) =>
      '<button data-model="' + m.id + '" class="model-row w-full flex items-center justify-between text-xs px-2.5 py-2 rounded-lg border transition-colors ' +
      (selectedModel === m.id ? 'bg-app-accent/10 border-app-accent/40 text-app-textLight' : 'border-transparent hover:bg-white/5 text-app-textLight') + '">' +
      '<span class="flex items-center gap-2"><i class="ph ' + escapeHtml(m.icon) + ' ' + escapeHtml(m.accent) + '"></i> ' + escapeHtml(m.name) + '</span>' +
      '<span class="text-app-text font-mono">' + escapeHtml(m.provider) + '</span>' +
      '</button>'
    ).join('');
  }

  function renderModelMenu() {
    $('#modelItems').innerHTML = models.map((m) =>
      '<button data-model="' + m.id + '" class="menu-item w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/5 transition-colors ' +
      (selectedModel === m.id ? 'text-app-textLight' : 'text-app-text') + '">' +
      '<i class="ph ' + escapeHtml(m.icon) + ' ' + escapeHtml(m.accent) + '"></i> ' + escapeHtml(m.name) +
      (selectedModel === m.id ? '<i class="ph ph-check text-app-accent ml-auto"></i>' : '') +
      '</button>'
    ).join('');
    const m = modelById(selectedModel);
    $('#modelLabel').textContent = m ? m.name : 'Modelo';
  }

  function renderAgentHeader() {
    const agent = convoAgent(activeConvo());
    $('#agentName').textContent = agent ? agent.name : 'Orbit';
    $('#agentDesc').textContent = agent ? (agent.description || 'Agente') : '';
    $('#agentIcon').className = 'ph-fill ' + (agent?.icon || 'ph-robot') + ' text-xl';
  }

  function renderAgentMenu() {
    $('#agentItems').innerHTML = agents.map((a) =>
      '<button data-agent="' + a.id + '" class="menu-item w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/5 transition-colors ' +
      (convoAgent(activeConvo())?.id === a.id ? 'text-app-textLight' : 'text-app-text') + '">' +
      '<i class="ph-fill ' + escapeHtml(a.icon) + ' text-app-textLight"></i>' +
      '<span class="min-w-0"><span class="block truncate">' + escapeHtml(a.name) + '</span>' +
      '<span class="block text-[10px] text-app-text truncate">' + escapeHtml(a.description || '') + '</span></span>' +
      (convoAgent(activeConvo())?.id === a.id ? '<i class="ph ph-check text-app-accent ml-auto"></i>' : '') +
      '</button>'
    ).join('');
  }

  function renderAccount() {
    const name = profile?.full_name || session?.user?.email?.split('@')[0] || 'Usuário';
    $('#userName').textContent = name;
    $('#userEmail').textContent = session?.user?.email || '';
    $('#userInitials').textContent = initials(name);
    if (profile?.avatar_url) {
      $('#userAvatar').innerHTML = '<img src="' + escapeHtml(profile.avatar_url) + '" class="w-full h-full object-cover" alt="">' +
        '<span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-app-accent border-2 border-app-bg rounded-full"></span>';
    }
  }

  function renderAttachChips() {
    const box = $('#attachChips');
    if (!pendingAttachments.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.classList.add('flex');
    box.innerHTML = pendingAttachments.map((a, i) =>
      '<span class="inline-flex items-center gap-1.5 text-[11px] bg-white/5 border border-app-border rounded-lg px-2 py-1 text-app-textLight">' +
      '<i class="ph ' + (a.kind === 'image' ? 'ph-image' : 'ph-file-text') + ' text-app-accent"></i>' + escapeHtml(a.name) +
      '<button data-att-del="' + i + '" class="text-app-text hover:text-app-red transition-colors" aria-label="Remover anexo"><i class="ph ph-x"></i></button></span>'
    ).join('');
  }

  function rerenderAll() {
    renderSidebar();
    renderChat(false);
    renderUsagePanel();
    renderModelMenu();
    renderAgentHeader();
    renderAgentMenu();
    renderAccount();
    document.title = 'OrbitAI — ' + (activeConvo()?.title || 'novo');
  }

  /* ----------------------------------------------------------
     Ciclo do chat
  ---------------------------------------------------------- */
  async function openConversation(id) {
    activeId = id;
    activeMessages = [];
    renderChat(false);
    try {
      activeMessages = await DB.listMessages(id);
    } catch (e) { toast('Falha ao carregar mensagens.', 'error'); }
    const convo = activeConvo();
    if (convo?.agent_id) activeAgentId = convo.agent_id;
    if (convo?.model_id) selectedModel = convo.model_id;
    rerenderAll();
  }

  async function refreshConversations() {
    try { conversations = await DB.listConversations(); } catch (e) { /* ignore */ }
    renderSidebar();
  }

  async function sendMessage(text) {
    text = text.trim();
    if ((!text && !pendingAttachments.length) || generating) return;

    const convo = activeConvo();
    const agent = convoAgent(convo);
    const atts = pendingAttachments.slice();
    pendingAttachments = [];
    renderAttachChips();

    // Render otimista da mensagem do usuário
    const userMsg = { role: 'user', content: text, created_at: new Date().toISOString(), attachments: atts };
    activeMessages.push(userMsg);
    const chat = $('#chat');
    $('#emptyState').classList.add('hidden');
    chat.appendChild(msgEl(userMsg));
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;

    // Placeholder do agente
    const placeholder = document.createElement('div');
    placeholder.className = 'flex gap-4 max-w-4xl msg-enter';
    placeholder.innerHTML =
      '<div class="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-app-textLight flex-shrink-0 mt-1"><i class="ph-fill ' + escapeHtml(agent?.icon || 'ph-robot') + ' text-lg"></i></div>' +
      '<div class="flex-1 min-w-0"><div class="flex items-center gap-2 text-xs text-app-text mb-2"><span class="font-medium text-app-textLight">' + escapeHtml(agent?.name || 'Orbit') + '</span> ' +
      '<span class="typing-dots"><span></span><span></span><span></span></span></div>' +
      '<div class="prose stream-target text-app-text text-sm italic">Pensando…</div></div>';
    chat.appendChild(placeholder);
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;

    generating = true;
    followBottom = true;
    setSendingUI(true);
    generation = { controller: new AbortController() };

    const target = placeholder.querySelector('.stream-target');
    let acc = '';
    let lastRender = 0;
    let stopped = false;

    try {
      const onDelta = (full) => {
        acc = full;
        const now = performance.now();
        if (now - lastRender > 60) {
          target.innerHTML = renderMarkdown(full) + '<span class="stream-caret"></span>';
          lastRender = now;
          if (followBottom) $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
        }
      };
      const out = await DB.streamChat({
        conversationId: activeId,
        content: text,
        agentId: agent?.id,
        model: selectedModel,
        attachments: atts,
        onDelta,
        onMeta: (meta) => {
          if (meta.conversation_id && !activeId) {
            activeId = meta.conversation_id;
            refreshConversations();
          }
        },
        signal: generation.controller.signal,
      });
      acc = out.content || acc;
      target.innerHTML = renderMarkdown(acc);
    } catch (e) {
      if (e.name === 'AbortError') {
        stopped = true;
        acc += '\n\n---\n*Geração interrompida.*';
        target.innerHTML = renderMarkdown(acc);
      } else {
        const is402 = e.status === 402;
        placeholder.querySelector('.prose').innerHTML =
          '<div class="border border-app-red/30 bg-app-red/10 rounded-lg p-3 text-sm text-app-red">' +
          '<div><i class="ph ph-warning-circle mr-1.5"></i>' + escapeHtml(e.message) + '</div>' +
          (is402 ? '<div class="text-xs text-app-text mt-1.5">Seus créditos acabaram. Eles renovam no próximo ciclo.</div>' : '') +
          '</div>';
        toast('Falha: ' + e.message, 'error');
      }
    } finally {
      generating = false;
      setSendingUI(false);
      updateToBottomBtn();
      placeholder.querySelector('.typing-dots')?.remove();
      placeholder.querySelector('.prose')?.classList.remove('stream-target', 'text-app-text', 'italic');
      // Recarrega mensagens reais do banco (inclui a resposta gravada)
      if (activeId && !stopped) {
        try { activeMessages = await DB.listMessages(activeId); renderChat(false); } catch (e) { /* ignore */ }
      }
      refreshConversations();
      renderUsagePanel();
    }
  }

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
    $('#btnToBottom').classList.toggle('hidden', !generating || isNearBottom());
  }
  function syncSendState() {
    const empty = !$('#input').value.trim() && !pendingAttachments.length;
    const btn = $('#btnSend');
    btn.classList.toggle('opacity-40', empty);
    btn.classList.toggle('pointer-events-none', empty);
  }

  async function regenerate() {
    if (generating || !activeId) return;
    // Remove a última resposta do assistente no banco e reenvia a última pergunta
    let i = activeMessages.length - 1;
    while (i >= 0 && activeMessages[i].role !== 'user') i--;
    if (i < 0) return;
    const lastUser = activeMessages[i].content;
    const toDelete = activeMessages.slice(i + 1).filter((m) => m.id);
    for (const m of toDelete) {
      try { await DB.sb.from('messages').delete().eq('id', m.id); } catch (e) { /* ignore */ }
    }
    activeMessages = activeMessages.slice(0, i + 1);
    renderChat(false);
    await sendMessage(lastUser);
  }

  function continueChat() {
    if (generating) return;
    sendMessage('Continue de onde parou e aprofunde o próximo ponto.');
  }

  /* ----------------------------------------------------------
     Anexos
  ---------------------------------------------------------- */
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|log|sql|sh|jsx|tsx)$/i;
  function handleFiles(files) {
    Array.from(files).slice(0, 8).forEach((f) => {
      if (f.size > 8 * 1024 * 1024) { toast(f.name + ': arquivo muito grande (máx. 8MB).', 'warn'); return; }
      if (f.type.startsWith('image/')) {
        const r = new FileReader();
        r.onload = () => { pendingAttachments.push({ name: f.name, kind: 'image', data_url: r.result, size: f.size }); renderAttachChips(); syncSendState(); };
        r.readAsDataURL(f);
      } else if (TEXT_EXT.test(f.name) || f.type.startsWith('text/')) {
        const r = new FileReader();
        r.onload = () => { pendingAttachments.push({ name: f.name, kind: 'text', text: String(r.result).slice(0, 20000), size: f.size }); renderAttachChips(); syncSendState(); };
        r.readAsText(f);
      } else {
        toast(f.name + ': formato não suportado (use texto ou imagem).', 'warn');
      }
    });
  }

  /* ----------------------------------------------------------
     Voz (Web Speech API)
  ---------------------------------------------------------- */
  let recog = null;
  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Ditado por voz não é suportado neste navegador.', 'warn'); return; }
    if (recog) { recog.stop(); return; }
    recog = new SR();
    recog.lang = 'pt-BR';
    recog.interimResults = true;
    const input = $('#input');
    const base = input.value;
    recog.onresult = (e) => {
      let t = '';
      for (const r of e.results) t += r[0].transcript;
      input.value = base + (base && !base.endsWith(' ') ? ' ' : '') + t;
      input.dispatchEvent(new Event('input'));
    };
    recog.onend = () => { recog = null; $('#btnMic').classList.remove('text-app-accent'); };
    recog.onerror = () => { recog = null; $('#btnMic').classList.remove('text-app-accent'); };
    recog.start();
    $('#btnMic').classList.add('text-app-accent');
    toast('Ouvindo… fale agora.', 'info');
  }

  /* ----------------------------------------------------------
     Shares / export
  ---------------------------------------------------------- */
  async function shareConvo() {
    if (!activeId) { toast('Nada para compartilhar.', 'warn'); return; }
    try {
      const share = await DB.createShare(activeId);
      const url = location.origin + location.pathname.replace(/[^/]*$/, 'share.html') + '?s=' + share.slug;
      await navigator.clipboard.writeText(url);
      toast('Link público copiado!');
    } catch (e) { toast('Falha ao compartilhar: ' + e.message, 'error'); }
  }

  function convoToMarkdown() {
    const c = activeConvo();
    let out = '# ' + (c?.title || 'Conversa') + '\n\n';
    activeMessages.forEach((m) => { out += (m.role === 'user' ? '## Você\n\n' : '## ' + (convoAgent(c)?.name || 'Orbit') + '\n\n') + m.content + '\n\n---\n\n'; });
    return out;
  }
  function copyConvo() {
    if (!activeMessages.length) { toast('Nada para copiar.', 'warn'); return; }
    navigator.clipboard.writeText(convoToMarkdown()).then(() => toast('Conversa copiada.'), () => toast('Não foi possível copiar.', 'warn'));
  }
  function exportConvo() {
    const c = activeConvo();
    if (!c || !activeMessages.length) { toast('Nada para exportar.', 'warn'); return; }
    const blob = new Blob([convoToMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = c.title.replace(/[^a-z0-9-]+/gi, '_').toLowerCase() + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exportado como .md');
  }

  /* ----------------------------------------------------------
     Conversas: nova / excluir / limpar
  ---------------------------------------------------------- */
  function newConversation() {
    activeId = null;
    activeMessages = [];
    rerenderAll();
    closeDrawers();
    $('#input').focus();
  }
  async function deleteConvo(id) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv || !confirm('Excluir a conversa "' + conv.title + '"?')) return;
    try {
      await DB.deleteConversation(id);
      conversations = conversations.filter((c) => c.id !== id);
      if (activeId === id) { activeId = null; activeMessages = []; }
      rerenderAll();
      toast('Conversa excluída.');
    } catch (e) { toast('Falha ao excluir: ' + e.message, 'error'); }
  }
  async function clearConvo() {
    if (!activeId) return;
    if (!confirm('Limpar as mensagens desta conversa?')) return;
    try {
      await DB.sb.from('messages').delete().eq('conversation_id', activeId);
      await DB.updateConversation(activeId, { title: 'Nova conversa' });
      activeMessages = [];
      await refreshConversations();
      rerenderAll();
      toast('Conversa limpa.');
    } catch (e) { toast('Falha ao limpar: ' + e.message, 'error'); }
  }

  /* ----------------------------------------------------------
     Menus / drawers / modais
  ---------------------------------------------------------- */
  function toggleMenu(el) { const willOpen = el.classList.contains('hidden'); closeAllMenus(); if (willOpen) el.classList.remove('hidden'); }
  function closeAllMenus() {
    ['modelMenu', 'moreMenu', 'accountPopover', 'agentMenu'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    const c = $('#accountCaret'); if (c) c.style.transform = '';
  }
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
  function openModal(id) { const m = document.getElementById(id); m.classList.remove('hidden'); m.classList.add('flex'); }
  function closeModal(id) { const m = document.getElementById(id); m.classList.add('hidden'); m.classList.remove('flex'); }

  /* ----------------------------------------------------------
     Agentes: modal + CRUD
  ---------------------------------------------------------- */
  function renderAgentsModal() {
    const uid = session?.user?.id;
    $('#agentsList').innerHTML = agents.map((a) => {
      const mine = a.owner_id === uid;
      return '<div class="flex items-start gap-3 p-3 rounded-xl border border-app-border bg-white/[0.02] mb-2">' +
        '<div class="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-app-textLight flex-shrink-0"><i class="ph-fill ' + escapeHtml(a.icon) + '"></i></div>' +
        '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-2"><span class="text-sm font-medium text-app-textLight">' + escapeHtml(a.name) + '</span>' +
        (mine ? '<span class="text-[9px] bg-app-accent/10 text-app-accent border border-app-accent/30 rounded px-1.5 py-0.5">seu</span>' : '<span class="text-[9px] bg-white/5 text-app-text border border-app-border rounded px-1.5 py-0.5">plataforma</span>') + '</div>' +
        '<div class="text-xs text-app-text mt-0.5 truncate">' + escapeHtml(a.description || '') + '</div>' +
        '</div>' +
        '<div class="flex items-center gap-1.5 flex-shrink-0">' +
        '<button data-agent-use="' + a.id + '" class="text-[11px] text-app-accent bg-app-accent/10 hover:bg-app-accent/20 border border-app-accent/30 rounded-md px-2.5 py-1.5 transition-colors">Usar</button>' +
        (mine ? '<button data-agent-edit="' + a.id + '" class="w-7 h-7 flex items-center justify-center text-app-text hover:text-app-textLight hover:bg-white/10 rounded-md transition-colors" title="Editar"><i class="ph ph-pencil-simple"></i></button>' : '') +
        '</div></div>';
    }).join('') || '<div class="text-xs text-app-text text-center py-6">Nenhum agente ainda.</div>';
  }

  function openAgentEditor(agent) {
    $('#agentEditorTitle').textContent = agent ? 'Editar agente' : 'Novo agente';
    $('#agentEditId').value = agent?.id || '';
    $('#agentEditName').value = agent?.name || '';
    $('#agentEditDesc').value = agent?.description || '';
    $('#agentEditIcon').value = agent?.icon || 'ph-robot';
    $('#agentEditPrompt').value = agent?.system_prompt || '';
    $('#agentEditModel').innerHTML = '<option value="">Padrão da conversa</option>' +
      models.map((m) => '<option value="' + m.id + '"' + (agent?.model_id === m.id ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>').join('');
    $('#agentEditDelete').classList.toggle('hidden', !agent || agent.owner_id !== session?.user?.id);
    openModal('agentEditorModal');
  }

  async function saveAgent() {
    const id = $('#agentEditId').value;
    const payload = {
      name: $('#agentEditName').value.trim(),
      description: $('#agentEditDesc').value.trim(),
      icon: $('#agentEditIcon').value.trim() || 'ph-robot',
      model_id: $('#agentEditModel').value || null,
      system_prompt: $('#agentEditPrompt').value.trim(),
    };
    if (!payload.name || !payload.system_prompt) { toast('Preencha nome e system prompt.', 'warn'); return; }
    try {
      if (id) await DB.updateAgent(id, payload);
      else await DB.createAgent(payload);
      agents = await DB.listAgents();
      renderAgentsModal();
      renderAgentMenu();
      renderAgentHeader();
      closeModal('agentEditorModal');
      toast('Agente salvo.');
    } catch (e) { toast('Falha ao salvar agente: ' + e.message, 'error'); }
  }

  /* ----------------------------------------------------------
     Settings / perfil / billing
  ---------------------------------------------------------- */
  function openSettings() {
    closeAllMenus();
    $('#prefName').value = profile?.full_name || '';
    openModal('settingsModal');
  }
  function closeSettings() { closeModal('settingsModal'); }
  async function saveSettings() {
    const name = $('#prefName').value.trim();
    try {
      await DB.sb.from('profiles').update({ full_name: name }).eq('id', session.user.id);
      profile.full_name = name;
      renderAccount();
      closeSettings();
      toast('Preferências salvas.');
    } catch (e) { toast('Falha ao salvar: ' + e.message, 'error'); }
  }

  async function exportAllData() {
    try {
      const dump = { exported_at: new Date().toISOString(), conversations: [] };
      for (const c of conversations) {
        const msgs = await DB.listMessages(c.id);
        dump.conversations.push({ ...c, messages: msgs });
      }
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'orbitai-export-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Dados exportados.');
    } catch (e) { toast('Falha ao exportar: ' + e.message, 'error'); }
  }

  async function clearAllData() {
    if (!confirm('Apagar TODAS as conversas? Esta ação não pode ser desfeita.')) return;
    try {
      for (const c of conversations) await DB.deleteConversation(c.id);
      conversations = [];
      activeId = null;
      activeMessages = [];
      rerenderAll();
      closeSettings();
      toast('Todas as conversas foram apagadas.');
    } catch (e) { toast('Falha: ' + e.message, 'error'); }
  }

  function openProfileModal() {
    closeAllMenus();
    const m = modelById(selectedModel);
    const agent = convoAgent(activeConvo());
    $('#profileBody').innerHTML =
      '<div class="flex items-center gap-3">' +
      '<div class="w-11 h-11 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-medium text-sm border border-purple-500/30 overflow-hidden">' +
      (profile?.avatar_url ? '<img src="' + escapeHtml(profile.avatar_url) + '" class="w-full h-full object-cover">' : escapeHtml(initials(profile?.full_name))) + '</div>' +
      '<div class="min-w-0">' +
      '<div class="text-sm font-medium text-app-textLight">' + escapeHtml(profile?.full_name || 'Usuário') + '</div>' +
      '<div class="text-xs text-app-text mt-0.5 truncate">' + escapeHtml(session?.user?.email || '') + '</div>' +
      '</div></div>' +
      '<div class="rounded-xl border border-app-border bg-white/[0.03] p-3.5 space-y-2.5 text-xs">' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Plano</span><span class="text-app-textLight capitalize">' + escapeHtml(profile?.plan || 'free') + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Créditos restantes</span><span class="text-app-textLight font-mono">' + formatNumber(profile?.credits) + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Agente ativo</span><span class="text-app-textLight">' + escapeHtml(agent?.name || '—') + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Modelo</span><span class="text-app-textLight">' + escapeHtml(m ? m.name : '—') + '</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-app-text">Membro desde</span><span class="text-app-textLight">' + new Date(profile?.created_at || Date.now()).toLocaleDateString('pt-BR') + '</span></div>' +
      '</div>' +
      '<div class="flex gap-2 pt-1">' +
      '<button id="profileOpenSettings" class="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-border bg-white/5 text-xs text-app-textLight hover:bg-white/10 transition-colors"><i class="ph ph-faders"></i> Preferências</button>' +
      '<button id="profileLogout" class="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-app-red/30 bg-app-red/10 text-xs text-app-red hover:bg-app-red/20 transition-colors"><i class="ph ph-sign-out"></i> Sair</button>' +
      '</div>';
    $('#profileOpenSettings').addEventListener('click', () => { closeModal('profileModal'); openSettings(); });
    $('#profileLogout').addEventListener('click', () => { closeModal('profileModal'); logoutAccount(); });
    openModal('profileModal');
  }

  async function openBillingModal() {
    closeAllMenus();
    let events = [];
    try { events = await DB.usageSummary(); } catch (e) { /* ignore */ }
    const totalTok = events.reduce((a, e) => a + e.tokens_in + e.tokens_out, 0);
    const totalCredits = events.reduce((a, e) => a + Number(e.credits || 0), 0);
    $('#billingBody').innerHTML =
      '<div class="rounded-xl border border-app-accent/30 bg-app-accent/10 p-3.5 text-xs space-y-1.5">' +
      '<div class="flex items-center gap-2 text-app-textLight font-medium"><i class="ph ph-rocket text-app-accent"></i> Plano ' + escapeHtml(profile?.plan || 'free') + ' — ' + formatNumber(CREDIT_TOTAL) + ' créditos por ciclo</div>' +
      '<div class="text-app-text">Restam <span class="text-app-textLight font-mono">' + formatNumber(profile?.credits) + ' créditos</span>.</div>' +
      '</div>' +
      '<div class="rounded-xl border border-app-border bg-white/[0.03] p-3.5 text-xs space-y-2">' +
      '<div class="font-medium text-app-textLight">Consumo do ciclo</div>' +
      '<div class="flex justify-between"><span class="text-app-text">Tokens processados</span><span class="font-mono">' + formatNumber(totalTok) + '</span></div>' +
      '<div class="flex justify-between"><span class="text-app-text">Créditos consumidos</span><span class="font-mono">' + formatNumber(totalCredits) + '</span></div>' +
      '<div class="flex justify-between"><span class="text-app-text">Requisições</span><span class="font-mono">' + formatNumber(events.length) + '</span></div>' +
      '</div>' +
      '<div class="text-[10px] text-app-text">Pagamentos e planos pagos chegam em breve via Stripe/Mercado Pago.</div>';
    openModal('billingModal');
  }

  async function logoutAccount() {
    if (!confirm('Sair da conta?')) return;
    await DB.signOut();
    location.replace('login.html');
  }

  /* ----------------------------------------------------------
     Eventos
  ---------------------------------------------------------- */
  function bindEvents() {
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
    $('#btnStop').addEventListener('click', () => { if (generating && generation.controller) generation.controller.abort(); });

    const chatScrollEl = $('#chatScroll');
    chatScrollEl.addEventListener('scroll', () => { followBottom = isNearBottom(); updateToBottomBtn(); });
    $('#btnToBottom').addEventListener('click', () => {
      followBottom = true;
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
      updateToBottomBtn();
    });

    // Delegação global de cliques
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-suggest]');
      if (chip) { input.value = SUGGESTIONS[+chip.dataset.suggest]; input.dispatchEvent(new Event('input')); input.focus(); return; }

      const attDel = e.target.closest('[data-att-del]');
      if (attDel) { pendingAttachments.splice(+attDel.dataset.attDel, 1); renderAttachChips(); syncSendState(); return; }

      const copy = e.target.closest('.copy-code');
      if (copy) {
        const code = copy.closest('.code-block').querySelector('pre').innerText;
        navigator.clipboard.writeText(code).then(() => toast('Código copiado.'), () => toast('Não foi possível copiar.', 'warn'));
        return;
      }

      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        const wrapper = act.closest('.msg-enter');
        const idx = wrapper ? Array.from($('#chat').children).indexOf(wrapper) : -1;
        const msg = idx >= 0 ? activeMessages[idx] : null;
        if (a === 'copy' && msg) {
          navigator.clipboard.writeText(msg.content).then(() => toast('Mensagem copiada.'), () => toast('Não foi possível copiar.', 'warn'));
        } else if ((a === 'like' || a === 'dislike') && msg && msg.id) {
          const v = a === 'like' ? (msg.feedback === 1 ? 0 : 1) : (msg.feedback === -1 ? 0 : -1);
          msg.feedback = v;
          DB.setFeedback(msg.id, v).catch(() => {});
          renderChat(false);
          toast(a === 'like' ? 'Obrigado pelo feedback!' : 'Anotado — vamos melhorar.', 'info');
        } else if (a === 'regen') { regenerate(); }
        else if (a === 'continue') { continueChat(); }
        return;
      }

      const modelItem = e.target.closest('[data-model]');
      if (modelItem) {
        selectedModel = modelItem.dataset.model;
        if (activeId) DB.updateConversation(activeId, { model_id: selectedModel }).catch(() => {});
        renderModelMenu();
        renderUsagePanel();
        $('#modelMenu').classList.add('hidden');
        return;
      }

      const agentItem = e.target.closest('[data-agent]');
      if (agentItem) {
        activeAgentId = agentItem.dataset.agent;
        if (activeId) {
          DB.updateConversation(activeId, { agent_id: activeAgentId }).then(refreshConversations).catch(() => {});
          const c = activeConvo(); if (c) c.agent_id = activeAgentId;
        }
        renderAgentHeader();
        renderAgentMenu();
        $('#agentMenu').classList.add('hidden');
        return;
      }
      const agentUse = e.target.closest('[data-agent-use]');
      if (agentUse) {
        activeAgentId = agentUse.dataset.agentUse;
        closeModal('agentsModal');
        newConversation();
        toast('Conversando com ' + (agentById(activeAgentId)?.name || 'agente') + '.');
        return;
      }
      const agentEdit = e.target.closest('[data-agent-edit]');
      if (agentEdit) { openAgentEditor(agentById(agentEdit.dataset.agentEdit)); return; }

      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteConvo(del.dataset.del); return; }
      const conv = e.target.closest('.conv-item');
      if (conv) { openConversation(conv.dataset.id); closeDrawers(); return; }

      const more = e.target.closest('[data-more]');
      if (more) {
        const t = more.dataset.more;
        $('#moreMenu').classList.add('hidden');
        if (t === 'copy') copyConvo();
        if (t === 'export') exportConvo();
        if (t === 'share') shareConvo();
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
      const closer = e.target.closest('[data-close]');
      if (closer) { closeModal(closer.dataset.close); return; }
    });

    // Toggles de menus
    $('#modelBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#modelMenu')); });
    $('#agentBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#agentMenu')); });
    $('#agentManage').addEventListener('click', () => { $('#agentMenu').classList.add('hidden'); renderAgentsModal(); openModal('agentsModal'); });
    $('#accountBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('#accountPopover');
      const open = !pop.classList.contains('hidden');
      closeAllMenus();
      if (!open) { pop.classList.remove('hidden'); $('#accountCaret').style.transform = 'rotate(180deg)'; } else { $('#accountCaret').style.transform = ''; }
    });
    $('#btnMore').addEventListener('click', (e) => { e.stopPropagation(); closeAllMenus(); $('#moreMenu').classList.toggle('hidden'); });
    $('#btnExport').addEventListener('click', exportConvo);
    $('#btnShare').addEventListener('click', shareConvo);

    // Conversas
    $('#btnNewChat').addEventListener('click', newConversation);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newConversation(); }
      if (e.key === 'Escape') { closeAllMenus(); closeDrawers(); ['settingsModal', 'agentsModal', 'agentEditorModal', 'profileModal', 'billingModal'].forEach(closeModal); }
    });
    $('#searchToggle').addEventListener('click', () => {
      const w = $('#searchWrap');
      w.classList.toggle('hidden');
      if (!w.classList.contains('hidden')) $('#searchInput').focus();
    });
    $('#searchInput').addEventListener('input', renderSidebar);

    // Painel direito
    $('#btnPanelRight').addEventListener('click', () => {
      const aside = $('#rightSidebar');
      if (window.matchMedia('(min-width: 1024px)').matches) aside.classList.toggle('collapsed');
      else { aside.classList.add('open'); showBackdrop(true, 'right'); }
    });
    $('#btnMenuLeft').addEventListener('click', () => { $('#leftSidebar').classList.add('open'); showBackdrop(true, 'left'); });
    $('#backdrop').addEventListener('click', closeDrawers);
    $('#rightClose').addEventListener('click', () => {
      if (window.matchMedia('(min-width: 1024px)').matches) $('#rightSidebar').classList.add('collapsed');
      else closeDrawers();
    });

    // Navegação
    $('#navAgents').addEventListener('click', () => { renderAgentsModal(); openModal('agentsModal'); });
    $('#navCredits').addEventListener('click', () => {
      const panel = $('#rightSidebar');
      if (!window.matchMedia('(min-width: 1024px)').matches) { panel.classList.add('open'); showBackdrop(true, 'right'); return; }
      panel.classList.remove('collapsed');
      panel.classList.remove('panel-flash');
      void panel.offsetWidth;
      panel.classList.add('panel-flash');
      setTimeout(() => panel.classList.remove('panel-flash'), 1000);
    });
    $('#navSettings').addEventListener('click', openSettings);
    $('#btnUsageDetails').addEventListener('click', openBillingModal);

    // Modais: fechar no backdrop
    ['settingsModal', 'agentsModal', 'agentEditorModal', 'profileModal', 'billingModal'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('click', (e) => {
        if (e.target.id === id || e.target.classList.contains('modal-backdrop')) closeModal(id);
      });
    });

    // Agentes
    $('#btnNewAgent').addEventListener('click', () => openAgentEditor(null));
    $('#agentEditSave').addEventListener('click', saveAgent);
    $('#agentEditDelete').addEventListener('click', async () => {
      const id = $('#agentEditId').value;
      if (!id || !confirm('Excluir este agente?')) return;
      try {
        await DB.deleteAgent(id);
        agents = await DB.listAgents();
        renderAgentsModal(); renderAgentMenu(); renderAgentHeader();
        closeModal('agentEditorModal');
        toast('Agente excluído.');
      } catch (e2) { toast('Falha ao excluir: ' + e2.message, 'error'); }
    });

    // Settings
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsSave').addEventListener('click', saveSettings);
    $('#btnExportData').addEventListener('click', exportAllData);
    $('#btnClearData').addEventListener('click', clearAllData);

    // Anexos e voz
    $('#btnAttach').addEventListener('click', () => $('#attachInput').click());
    $('#attachInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    $('#btnMic').addEventListener('click', toggleMic);
    $('#btnProvider').addEventListener('click', openBillingModal);
  }

  function doSend() {
    const v = $('#input').value;
    if ((!v.trim() && !pendingAttachments.length) || generating) return;
    $('#input').value = '';
    $('#input').style.height = 'auto';
    syncSendState();
    sendMessage(v);
  }

  /* ----------------------------------------------------------
     Preloader
  ---------------------------------------------------------- */
  function runPreloader() {
    const pre = $('#preloader');
    const bar = $('#loading-bar');
    if (reducedMotion) { pre.style.display = 'none'; return; }
    setTimeout(() => { bar.style.width = '35%'; }, 200);
    setTimeout(() => { bar.style.width = '78%'; }, 700);
    setTimeout(() => {
      bar.style.width = '100%';
      pre.style.transition = 'opacity 0.5s ease, visibility 0.5s ease';
      pre.style.opacity = '0';
      pre.style.visibility = 'hidden';
      setTimeout(() => { pre.style.display = 'none'; }, 500);
    }, 1100);
  }

  /* ----------------------------------------------------------
     Init: auth gate + carga inicial
  ---------------------------------------------------------- */
  async function init() {
    if (!DB || !DB.configured) {
      $('#preloader').innerHTML =
        '<div class="max-w-sm text-center px-6">' +
        '<i class="ph ph-warning-circle text-app-red text-3xl"></i>' +
        '<h2 class="text-app-textLight text-lg font-medium mt-3 mb-2">Supabase não configurado</h2>' +
        '<p class="text-sm text-app-text">Edite <code class="font-mono text-app-accent">frontend/js/config.js</code> com a URL e a anon key do seu projeto. Veja o README.md.</p></div>';
      return;
    }

    session = await DB.getSession();
    if (!session) { location.replace('login.html'); return; }

    bindEvents();
    runPreloader();

    try {
      [profile, models, agents, conversations] = await Promise.all([
        DB.getProfile(), DB.listModels(), DB.listAgents(), DB.listConversations(),
      ]);
    } catch (e) {
      toast('Falha ao carregar dados: ' + e.message, 'error');
    }

    selectedModel = models[0]?.id || null;
    activeAgentId = agents.find((a) => a.name === 'Orbit')?.id || agents[0]?.id || null;

    if (conversations.length) await openConversation(conversations[0].id);
    else rerenderAll();

    // Sessão expirada em outra aba → volta pro login
    DB.onAuthChange((event) => { if (event === 'SIGNED_OUT') location.replace('login.html'); });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('load', () => { setTimeout(() => $('#input')?.focus(), 400); });
})();
