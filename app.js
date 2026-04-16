/**
 * app.js — Hospital AI Frontend Logic
 *
 * This file handles everything the user can interact with:
 *  - Navigation between panels (Search, Inventory, Dashboard, Memory, History)
 *  - Sending messages to the backend API (/chat)
 *  - Rendering AI replies as styled cards
 *  - Voice search using the Web Speech API
 *  - Dark / Light theme switching
 *  - Profile editing
 *  - Settings modal
 *  - Search history and recents sidebar
 */

/* ═══════════════════════════════════════════════════════════
   STATE
   These variables are shared across functions throughout this file.
═══════════════════════════════════════════════════════════ */

let searchHistory = [];   // Array of { query, time, memoryUsed }
let totalSearches = 0;    // Running count shown in the dashboard and profile
let isListening   = false; // True when voice recognition is active
let isDark        = true;  // Current theme state

// Local mirror of how many times each term has been searched this session.
// This is displayed in the Memory panel and also sent to the server for restock logic.
let localFreq = {}; // e.g. { "insulin": 3, "paracetamol": 1 }

// A unique user ID persisted in localStorage so the server can scope memory per user.
// This means the AI remembers your previous queries across page reloads.
const currentUserId = 'user-' + (
  localStorage.getItem('hospital_user_id') ||
  (() => {
    const id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('hospital_user_id', id);
    return id;
  })()
);

/* ═══════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════ */

/** Toggle between dark and light themes (used by the topbar toggle) */
function toggleTheme() {
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  document.getElementById('btn-dark').classList.toggle('active', isDark);
  document.getElementById('btn-light').classList.toggle('active', !isDark);
}

/** Set theme from the Settings modal theme cards */
function setThemeSetting(mode) {
  isDark = mode === 'dark';
  document.documentElement.setAttribute('data-theme', mode);
  document.getElementById('btn-dark').classList.toggle('active', isDark);
  document.getElementById('btn-light').classList.toggle('active', !isDark);
  document.getElementById('theme-dark-card').style.borderColor  = isDark  ? 'var(--accent)' : 'var(--border)';
  document.getElementById('theme-light-card').style.borderColor = !isDark ? 'var(--accent)' : 'var(--border)';
}

/* ═══════════════════════════════════════════════════════════
   VOICE SEARCH
   Uses the browser's Web Speech API (best supported in Chrome).
═══════════════════════════════════════════════════════════ */

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SR) {
    alert("Voice not supported. Please open in Google Chrome.");
    return;
  }

  if (isListening) return; // Prevent starting twice

  const rec = new SR();
  rec.lang = 'en-IN';       // Indian English — change if needed
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  isListening = true;
  document.getElementById('micBtn').classList.add('listening');
  rec.start();

  // When speech is recognised: put it in the input and immediately send
  rec.onresult = (e) => {
    document.getElementById('msgInput').value = e.results[0][0].transcript;
    isListening = false;
    document.getElementById('micBtn').classList.remove('listening');
    send();
  };

  // Clean up mic state if recognition fails or ends
  rec.onerror = () => { isListening = false; document.getElementById('micBtn').classList.remove('listening'); };
  rec.onend   = () => { isListening = false; document.getElementById('micBtn').classList.remove('listening'); };
}

/* ═══════════════════════════════════════════════════════════
   NAVIGATION
   Each panel (Search, Inventory, Dashboard, Memory, History)
   is a hidden <div>. These helpers show the right one.
═══════════════════════════════════════════════════════════ */

const ALL_PANELS = ['emptyState', 'messages', 'inventoryPanel', 'dashboardPanel', 'memoryPanel', 'historyPanel'];

/** Hide all panels and the alert bar */
function hideAll() {
  ALL_PANELS.forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('alertBar').style.display = 'none';
}

/** Highlight the active nav item in the sidebar */
function setActive(id) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/** Update the topbar title and badge text */
function setTopbar(title, badge) {
  document.getElementById('topbarTitle').textContent = title;
  const b = document.getElementById('topbarBadge');
  b.textContent = badge || '';
  b.style.display = badge ? '' : 'none';
}

/** Start a brand-new chat (clears the messages panel) */
function newChat() {
  hideAll();
  document.getElementById('messages').innerHTML = '';
  document.getElementById('emptyState').style.display = 'flex';
  setActive('nav-search');
  setTopbar('Search medicines', 'AI Powered');
  document.getElementById('msgInput').focus();
}

/** Show the AI chat / search panel */
function showSearch() {
  hideAll();
  setActive('nav-search');
  setTopbar('Search medicines', 'AI Powered');
  const msgs = document.getElementById('messages');
  // If there are existing messages, show them; otherwise show the welcome state
  if (msgs.innerHTML.trim() === '') {
    document.getElementById('emptyState').style.display = 'flex';
  } else {
    msgs.style.display = 'flex';
  }
  document.getElementById('msgInput').focus();
}

/** Show the Inventory panel */
function showInventory() {
  hideAll();
  setActive('nav-inventory');
  setTopbar('Inventory', '28 medicines');
  document.getElementById('alertBar').style.display = 'flex';
  document.getElementById('inventoryPanel').style.display = 'block';
}

/** Show the Dashboard panel */
function showDashboard() {
  hideAll();
  setActive('nav-dashboard');
  setTopbar('Dashboard', 'April 2026');
  document.getElementById('totalSearchesDisplay').textContent = totalSearches;
  document.getElementById('dashboardPanel').style.display = 'block';
}

/** Show the Memory & Insights panel (then render its contents) */
function showMemory() {
  hideAll();
  setActive('nav-memory');
  setTopbar('Memory & Insights', '🧠 Hindsight');
  renderMemoryPanel();
  document.getElementById('memoryPanel').style.display = 'block';
}

/** Show the History panel (then render its contents) */
function showHistory() {
  hideAll();
  setActive('nav-history');
  setTopbar('History', searchHistory.length + ' searches');
  renderHistory();
  document.getElementById('historyPanel').style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════
   MEMORY PANEL RENDERER
   Populates the three sections: restock predictions,
   search frequency, and session memory log.
═══════════════════════════════════════════════════════════ */

function renderMemoryPanel() {
  // ── Restock Predictions ──────────────────────────────────
  // Show any medicine searched ≥2 times as a potential restock candidate
  const restockList  = document.getElementById('restockList');
  const restockItems = Object.entries(localFreq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (restockItems.length === 0) {
    restockList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Search medicines a few times to see restock predictions here.</div>';
  } else {
    restockList.innerHTML = restockItems.map(([name, count]) =>
      `<div class="restock-card">
        <div class="restock-info">
          <div class="med-name">⚠️ ${escHtml(name)}</div>
          <div class="restock-detail">Searched ${count}× this session — verify stock level</div>
        </div>
        <div class="restock-badge-count">🔁 Restock?</div>
      </div>`
    ).join('');
  }

  // ── Search Frequency ─────────────────────────────────────
  const freqList  = document.getElementById('freqList');
  const freqItems = Object.entries(localFreq).sort((a, b) => b[1] - a[1]);

  if (freqItems.length === 0) {
    freqList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No searches yet this session.</div>';
  } else {
    freqList.innerHTML = freqItems.map(([name, count]) =>
      `<div class="memory-entry" style="display:flex;align-items:center;justify-content:space-between;">
        <div><div class="memory-query">${escHtml(name)}</div></div>
        <span class="memory-count">${count}× searched</span>
      </div>`
    ).join('');
  }

  // ── Session Memory Log ───────────────────────────────────
  const memoryList = document.getElementById('memoryList');

  if (searchHistory.length === 0) {
    memoryList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Queries are retained in Hindsight memory and recalled in future sessions to give you personalised responses.</div>';
  } else {
    // Show the 8 most recent, newest first
    memoryList.innerHTML = [...searchHistory].reverse().slice(0, 8).map(item =>
      `<div class="memory-entry">
        <div class="memory-query">🔍 ${escHtml(item.query)}</div>
        <div class="memory-time">
          ${item.time}
          ${item.memoryUsed ? '· <span style="color:var(--accent);">🧠 memory recalled</span>' : ''}
        </div>
      </div>`
    ).join('');
  }
}

/* ═══════════════════════════════════════════════════════════
   INVENTORY FILTER
   Filters the medicine cards in the Inventory panel by
   name text and/or stock status category.
═══════════════════════════════════════════════════════════ */

/** Called on every keystroke in the inventory search box */
function filterInventory(val) {
  const query = val.toLowerCase();
  // Find which status filter button is active
  const activeBtn    = document.querySelector('.inv-filter.active-filter');
  const activeStatus = activeBtn ? (activeBtn.dataset.status || 'all') : 'all';

  document.querySelectorAll('#invList .med-card').forEach(card => {
    const matchName   = card.dataset.name.includes(query);
    const matchStatus = activeStatus === 'all' || card.dataset.status === activeStatus;
    card.style.display = (matchName && matchStatus) ? '' : 'none';
  });
}

/** Called when one of the status filter buttons is clicked */
function filterByStatus(status, btn) {
  // Remove active class from all filter buttons and add to the clicked one
  document.querySelectorAll('.inv-filter').forEach(b => b.classList.remove('active-filter'));
  btn.classList.add('active-filter');
  btn.dataset.status = status;

  const query = document.querySelector('.search-input')?.value.toLowerCase() || '';

  document.querySelectorAll('#invList .med-card').forEach(card => {
    const matchName   = !query || card.dataset.name.includes(query);
    const matchStatus = status === 'all' || card.dataset.status === status;
    card.style.display = (matchName && matchStatus) ? '' : 'none';
  });

  // Hide section labels whose first visible card is gone
  document.querySelectorAll('#invList .section-tag').forEach(tag => {
    const next = tag.nextElementSibling;
    tag.style.display = (next && next.style.display !== 'none') ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════════════════════ */

function renderHistory() {
  const list = document.getElementById('historyList');

  if (searchHistory.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding-top:8px;">No history yet. Start searching!</div>';
    return;
  }

  list.innerHTML = [...searchHistory].reverse().map(item =>
    `<div class="history-item">
      <div>
        <div class="h-query">🔍 ${escHtml(item.query)}</div>
        <div class="h-time">
          ${item.time}
          ${item.memoryUsed ? ' · <span style="color:var(--accent);font-size:11px;">🧠 memory used</span>' : ''}
        </div>
      </div>
      <button class="btn-repeat" onclick="searchAgain('${escHtml(item.query)}')">Search again →</button>
    </div>`
  ).join('');
}

function clearHistory() {
  searchHistory = [];
  localFreq     = {};
  renderHistory();
}

/* ═══════════════════════════════════════════════════════════
   QUICK HELPERS
═══════════════════════════════════════════════════════════ */

/** Re-run a past query from the History panel */
function searchAgain(query) {
  showSearch();
  document.getElementById('msgInput').value = query;
  send();
}

/** Run a quick search from the empty-state suggestion chips */
function quickSearch(q) {
  document.getElementById('msgInput').value = q;
  send();
}

/** Add a search term to the Recents sidebar */
function addRecent(text) {
  const noRecents = document.getElementById('noRecents');
  if (noRecents) noRecents.remove();

  const recents = document.getElementById('recents');

  // Remove duplicate if the same term is already shown
  const existing = [...recents.querySelectorAll('.recent-item')]
    .find(el => el.dataset.query === text);
  if (existing) existing.remove();

  const item = document.createElement('div');
  item.className    = 'recent-item';
  item.dataset.query = text;
  item.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    ${text.length > 24 ? text.slice(0, 24) + '…' : text}`;
  item.onclick = () => searchAgain(text);
  recents.prepend(item);

  // Keep at most 8 recent items
  const items = recents.querySelectorAll('.recent-item');
  if (items.length > 8) items[items.length - 1].remove();
}

/* ═══════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
═══════════════════════════════════════════════════════════ */

/** Auto-grow the textarea as the user types */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

/** Send on Enter (but allow Shift+Enter for newlines) */
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

/** Safely escape user-supplied strings before inserting into HTML */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Copy a text string to the clipboard and briefly tint the button green */
function copyText(btn, text) {
  navigator.clipboard.writeText(text).catch(() => {});
  btn.style.color = 'var(--green)';
  setTimeout(() => btn.style.color = '', 1500);
}

/** Return the current time as HH:MM */
function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ═══════════════════════════════════════════════════════════
   REPLY PARSER
   Converts the plain-text reply from the server into
   styled HTML with badges, notes cards, and action buttons.
═══════════════════════════════════════════════════════════ */

/**
 * @param {string} reply          - The raw text from the AI
 * @param {boolean} memoryInjected - Whether the server used past context
 * @param {Array}  restockAlerts  - Any low-stock / high-demand warnings
 * @returns {string} HTML string ready to inject into the DOM
 */
function parseReply(reply, memoryInjected, restockAlerts) {
  const lines     = reply.split('\n').filter(l => l.trim());
  const firstLine = lines[0] || '';

  // Decide the colour of the status badge based on the emoji in the first line
  let badgeClass = '';
  if (firstLine.includes('✅'))      badgeClass = 'badge-ok';
  else if (firstLine.includes('⚠️')) badgeClass = 'badge-warn';
  else if (firstLine.includes('❌')) badgeClass = 'badge-err';

  let html = '<div class="message-bot">';
  html += '<div class="bot-label"><div class="bot-label-dot"></div>Result</div>';

  // Memory and restock badges (shown near the top of the reply)
  if (memoryInjected) {
    html += '<div style="margin-bottom:10px;"><span class="memory-badge">🧠 Memory active — personalised response</span>';
    if (restockAlerts && restockAlerts.length > 0) {
      html += `<span class="restock-badge">🔁 Restock alert: ${escHtml(restockAlerts[0].medicine)}</span>`;
    }
    html += '</div>';
  } else if (restockAlerts && restockAlerts.length > 0) {
    html += `<div style="margin-bottom:10px;"><span class="restock-badge">🔁 Restock alert: ${escHtml(restockAlerts[0].medicine)}</span></div>`;
  }

  // Main result card
  html += '<div class="result-card">';
  html += `<div class="result-top"><span class="badge ${badgeClass}">${escHtml(firstLine)}</span></div>`;
  html += '<div class="result-body">';

  // Lines 2..N — stop before any "notes" lines (📊 🔥 💡)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('📊') || lines[i].includes('🔥') || lines[i].includes('💡')) break;
    html += escHtml(lines[i]) + '\n';
  }
  html += '</div></div>';

  // Notes card — lines that start with insight emojis
  const noteLines = lines.filter(l => l.includes('📊') || l.includes('🔥') || l.includes('💡'));
  if (noteLines.length > 0) {
    html += '<div class="notes-card"><div class="notes-title">Notes</div><ul>';
    noteLines.forEach(n => { html += `<li>${escHtml(n)}</li>`; });
    html += '</ul></div>';
  }

  // Copy button — we escape backticks and backslashes for the inline onclick
  const replyEsc = reply.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  html += `<div class="msg-actions">
    <button class="action-btn" title="Copy" onclick="copyText(this,\`${replyEsc}\`)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
    </button>
  </div>`;
  html += '</div>';

  return html;
}

/* ═══════════════════════════════════════════════════════════
   MAIN SEND FUNCTION
   Reads the text input, shows it as a user bubble, calls
   the backend /chat API, then renders the AI reply.
═══════════════════════════════════════════════════════════ */

async function send() {
  const input   = document.getElementById('msgInput');
  const message = input.value.trim();
  if (!message) return;

  // Clear the input
  input.value = '';
  input.style.height = 'auto';

  // Switch to the chat view
  hideAll();
  setActive('nav-search');
  setTopbar('Search medicines', 'AI Powered');

  const msgs = document.getElementById('messages');
  msgs.style.display = 'flex';

  // ── Append the user's message bubble ──
  const userWrap = document.createElement('div');
  const userDiv  = document.createElement('div');
  userDiv.className  = 'message-user';
  userDiv.textContent = message;
  userWrap.appendChild(userDiv);
  msgs.appendChild(userWrap);

  // ── Show animated typing dots while waiting for the server ──
  const typingWrap = document.createElement('div');
  typingWrap.id = 'typingIndicator';
  typingWrap.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(typingWrap);
  msgs.scrollTop = msgs.scrollHeight;

  document.getElementById('sendBtn').disabled = true;

  try {
    // POST to the backend — relative URL works on any host
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, user: currentUserId })
    });

    const data = await res.json();
    typingWrap.remove();

    // Track search frequency locally (used in the Memory panel display)
    const key = message.toLowerCase().trim();
    localFreq[key] = (localFreq[key] || 0) + 1;

    // Render the AI reply
    const botWrap = document.createElement('div');
    botWrap.innerHTML = parseReply(data.reply, data.memoryInjected, data.restockAlerts);
    msgs.appendChild(botWrap);
    msgs.scrollTop = msgs.scrollHeight;

    // Update session stats
    totalSearches++;
    searchHistory.push({ query: message, time: nowTime(), memoryUsed: data.memoryInjected });
    addRecent(message);

  } catch (err) {
    // The server is not running or network is down
    typingWrap.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'message-bot';
    errDiv.innerHTML = `
      <div class="result-card" style="border-color:var(--red-bg);">
        <div style="color:var(--red);font-size:14px;font-weight:500;">⚠️ Server unavailable</div>
        <div style="color:var(--text-muted);font-size:13px;margin-top:6px;">
          Make sure the server is running: <code>node server.js</code>
        </div>
      </div>`;
    msgs.appendChild(errDiv);
    msgs.scrollTop = msgs.scrollHeight;
  }

  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

/* ═══════════════════════════════════════════════════════════
   PROFILE MODAL
═══════════════════════════════════════════════════════════ */

function showProfile() {
  document.getElementById('statSearches').textContent = totalSearches;
  document.getElementById('profileOverlay').style.display = 'flex';
  switchTab('info');
}

function closeProfile() {
  document.getElementById('profileOverlay').style.display = 'none';
}

/** Close the profile modal when clicking on the backdrop */
function closeProfileIfOutside(e) {
  if (e.target === document.getElementById('profileOverlay')) closeProfile();
}

/** Switch between Info / Edit Profile / Security tabs */
function switchTab(tab) {
  ['info', 'edit', 'security'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    // Capitalise first letter for the panel IDs: tabInfo, tabEdit, tabSecurity
    document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).style.display =
      t === tab ? 'block' : 'none';
  });
}

/** Save profile changes and update all name/role displays across the UI */
function saveProfile() {
  const name     = document.getElementById('editName').value.trim()  || 'Dinesh Varma';
  const role     = document.getElementById('editRole').value;
  const email    = document.getElementById('editEmail').value.trim();
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  // Update every place on the page that shows the user's name / role
  document.getElementById('profileAvatarLarge').textContent = initials;
  document.getElementById('sidebarAvatar').textContent      = initials;
  document.getElementById('profileDisplayName').textContent = name;
  document.getElementById('profileRoleBadge').textContent   = role;
  document.getElementById('sidebarName').textContent        = name;
  document.getElementById('sidebarRole').textContent        = role;
  document.getElementById('infoName').textContent           = name;
  document.getElementById('infoRole').textContent           = role;
  document.getElementById('infoEmail').textContent          = email;

  switchTab('info'); // Return to the info tab after saving
}

/* ═══════════════════════════════════════════════════════════
   SETTINGS MODAL
═══════════════════════════════════════════════════════════ */

function showSettings() {
  document.getElementById('aboutSearchCount').textContent = totalSearches;
  document.getElementById('settingsOverlay').style.display = 'flex';
  checkServerStatus(); // Ping the server health endpoint when opening settings
}

function closeSettings() {
  document.getElementById('settingsOverlay').style.display = 'none';
}

function closeSettingsIfOutside(e) {
  if (e.target === document.getElementById('settingsOverlay')) closeSettings();
}

/** Ping the backend /health endpoint and update the status badge in Settings */
async function checkServerStatus() {
  const badge = document.getElementById('serverStatusBadge');
  try {
    const r = await fetch('/health');
    if (r.ok) {
      badge.textContent   = '● Online';
      badge.style.color   = 'var(--green)';
    } else {
      badge.textContent = '● Error';
      badge.style.color = 'var(--red)';
    }
  } catch {
    badge.textContent = '● Offline';
    badge.style.color = 'var(--yellow)';
  }
}

/* ═══════════════════════════════════════════════════════════
   GLOBAL KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeProfile();
    closeSettings();
  }
});