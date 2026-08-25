/* ---------------------------------------------------------------------
   Storage layer: IndexedDB
   ---------------------------------------------------------------------
   Everything lives on-device in IndexedDB — no network calls after the
   first load (the service worker caches the app shell itself). This is
   what makes day-to-day use zero-bandwidth, and why the app works fully
   offline. There's no built-in iCloud sync in this version — instead,
   the Backup tab lets you export a JSON file and re-import it on another
   device (AirDrop / Files / email to yourself), which covers "don't lose
   my historical data" without needing a backend or Apple Developer setup.
   If you want real cross-device sync later, CloudKit JS can be layered
   on top of this same data model without changing the schema.
------------------------------------------------------------------------ */

const DB_NAME = 'field-notes-db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) {
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('todos')) {
        d.createObjectStore('todos', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('goals')) {
        const g = d.createObjectStore('goals', { keyPath: 'id' });
        g.createIndex('effectiveDate', 'effectiveDate');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, obj) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(obj);
  return txDone(tx);
}
async function dbDelete(store, id) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return txDone(tx);
}
async function dbClearAndFill(store, items) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  const os = tx.objectStore(store);
  items.forEach((item) => os.put(item));
  return txDone(tx);
}

/* ---------------------------------------------------------------------
   In-memory state (mirrors IndexedDB; UI renders from here synchronously,
   writes go to both memory and IndexedDB together)
------------------------------------------------------------------------ */

const CATS = {
  study:   { label: "Study",   hex: "#e0a452" },
  explore: { label: "Explore", hex: "#5fb3a3" },
  think:   { label: "Think",   hex: "#a594d1" },
  build:   { label: "Build",   hex: "#c1585f" },
  write:   { label: "Write",   hex: "#5b8ec9" }
};
const CAT_KEYS = Object.keys(CATS);

const QUOTES = [
  "Progress, not permanence — every hour logged is an hour understood.",
  "The dissertation is written one dial at a time.",
  "Confusion today is data for tomorrow's clarity.",
  "Small, steady arcs beat one heroic burst.",
  "Thinking time counts. Staring at the ceiling is research.",
  "You don't need a breakthrough today. You need a data point.",
  "Two hours of thinking a day, every day, is how a thesis gets solved.",
  "Show up for the hard problem before it's ready to be solved."
];

let sessions = [];
let todos = [];
let goals = [];
let activeTab = 'today';
let activeTodoTab = 'daily'; // 'daily' | 'long'

/* Groups a list of todos by category (in CAT_KEYS order, uncategorized
   items last under "General") for rendering as sections. */
function groupTodosByCategory(list) {
  const groups = {};
  CAT_KEYS.forEach((k) => { groups[k] = []; });
  groups.general = [];
  list.forEach((t) => {
    const key = CAT_KEYS.includes(t.category) ? t.category : 'general';
    groups[key].push(t);
  });
  return groups;
}
function categoryDotHtml(catKey) {
  const hex = CATS[catKey] ? CATS[catKey].hex : '#8993a3';
  return `<span class="cat-dot" style="background:${hex}"></span>`;
}

let timer = { running: false, category: null, startedAt: null };
let tickInterval = null;

function loadTimerFromLocalStorage() {
  try {
    const raw = localStorage.getItem('field-notes-timer');
    if (raw) timer = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}
function saveTimerToLocalStorage() {
  localStorage.setItem('field-notes-timer', JSON.stringify(timer));
}

function uid() { return Math.random().toString(36).slice(2, 10); }
function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function fmtClock(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function fmtHrs(min) {
  if (min === 0) return "0m";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function totalsFor(sessionList) {
  const t = {};
  CAT_KEYS.forEach((k) => { t[k] = 0; });
  sessionList.forEach((s) => { if (t[s.category] !== undefined) t[s.category] += s.minutes; });
  return t;
}
function sessionsOn(day) {
  const key = todayStr(day);
  return sessions.filter((s) => s.date === key);
}

/* Goal is versioned: each entry says "from this date on, the target is
   X minutes". Historical days are judged by whatever was active then, so
   raising your target later doesn't rewrite past streaks. */
function goalMinutesOn(day) {
  const key = todayStr(day);
  const applicable = goals.filter((g) => g.effectiveDate <= key).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return applicable.length ? applicable[applicable.length - 1].thinkGoalMinutes : 120;
}

function computeThinkGoalStreak() {
  let streak = 0;
  let cursor = new Date();
  const todayGoal = goalMinutesOn(cursor);
  const todayMet = totalsFor(sessionsOn(cursor)).think >= todayGoal;
  if (!todayMet) cursor.setDate(cursor.getDate() - 1);
  while (true) {
    const goal = goalMinutesOn(cursor);
    const met = totalsFor(sessionsOn(cursor)).think >= goal;
    if (met) { streak++; cursor.setDate(cursor.getDate() - 1); } else break;
  }
  return streak;
}
function computeBestThinkStreak() {
  if (sessions.length === 0) return 0;
  const earliest = sessions.reduce((min, s) => (s.date < min ? s.date : min), sessions[0].date);
  let cursor = new Date(earliest + 'T00:00:00');
  const end = new Date();
  let best = 0, current = 0;
  while (cursor <= end) {
    const goal = goalMinutesOn(cursor);
    const met = totalsFor(sessionsOn(cursor)).think >= goal;
    if (met) { current++; best = Math.max(best, current); } else current = 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  return best;
}

function polar(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startDeg, endDeg) {
  const s = polar(cx, cy, r, endDeg);
  const e = polar(cx, cy, r, startDeg);
  const largeArc = endDeg - startDeg <= 180 ? "0" : "1";
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
}
function renderDial(totals) {
  const scaleMin = 8 * 60;
  const cx = 100, cy = 100, r = 78, sw = 22;
  let deg = 0, arcs = '';
  CAT_KEYS.forEach((cat) => {
    const min = totals[cat];
    const sweep = Math.min(min / scaleMin, 1) * 360;
    if (sweep > 0.5) {
      arcs += `<path d="${describeArc(cx, cy, r, deg, deg + sweep)}" stroke="${CATS[cat].hex}" stroke-width="${sw}" fill="none"/>`;
    }
    deg += sweep;
  });
  const totalMin = CAT_KEYS.reduce((sum, k) => sum + totals[k], 0);
  return `<svg viewBox="0 0 200 200" width="140" height="140">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="var(--track)" stroke-width="${sw}" fill="none"/>
    ${arcs}
    <text x="100" y="95" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="22" font-weight="600" fill="var(--text)">${fmtHrs(totalMin)}</text>
    <text x="100" y="114" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9" letter-spacing="1" fill="var(--muted)">TODAY / 8H</text>
  </svg>`;
}
function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  return days;
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderTodoList(listType, idPrefix, visible, heading) {
  const today = todayStr();
  const list = todos.filter((t) => listType === 'daily' ? t.linkedDate === today : !t.linkedDate);
  const groups = groupTodosByCategory(list);
  const order = [...CAT_KEYS, 'general'];
  const inputId = `${idPrefix}TodoInput`;
  const selectId = `${idPrefix}CategorySelect`;
  const addBtnId = `${idPrefix}AddBtn`;
  const hint = listType === 'daily'
    ? "Today's list — tasks you add here belong to today only."
    : "Backlog — tasks here stick around until you finish or delete them.";

  const groupsHtml = order.map((key) => {
    const items = groups[key];
    if (items.length === 0) return '';
    const label = key === 'general' ? 'General' : CATS[key].label;
    return `
      <div class="todo-group">
        <div class="todo-group-label">${categoryDotHtml(key)}${label}</div>
        <ul class="todo-list">
          ${items.slice().sort((a, b) => a.isDone - b.isDone).map((t) => `
            <li class="todo-item ${t.isDone ? 'done' : ''}">
              <span class="todo-check ${t.isDone ? 'checked' : ''}" data-id="${t.id}">${t.isDone ? '✓' : ''}</span>
              <span class="todo-text">${escapeHtml(t.text)}</span>
              <button class="todo-del" data-id="${t.id}">✕</button>
            </li>`).join('')}
        </ul>
      </div>`;
  }).join('');

  const doneCount = list.filter((t) => t.isDone).length;
  const headingHtml = heading
    ? `<h2>${heading} ${list.length ? `<span style="color:var(--muted); font-weight:400; font-size:12px;">(${doneCount}/${list.length} done)</span>` : ''}</h2>`
    : '';

  return `
    <div class="card" data-todopanel="${idPrefix}" style="${visible ? '' : 'display:none;'}">
      ${headingHtml}
      <p class="todo-hint">${hint}</p>
      <div class="todo-input-row">
        <input type="text" id="${inputId}" placeholder="What's next?">
        <select id="${selectId}">
          <option value="">General</option>
          ${CAT_KEYS.map((k) => `<option value="${k}">${CATS[k].label}</option>`).join('')}
        </select>
        <button class="btn primary" id="${addBtnId}">Add</button>
      </div>
      ${list.length === 0 ? '<div class="todo-empty">Nothing here yet — add your first task above.</div>' : groupsHtml}
    </div>`;
}

/* Contexts the todo add-form/list gets rendered in: the embedded card on
   the Today tab (always visible, prefix "todayTab"), and the two panels
   inside the dedicated To-Do tab (prefix "daily" / "long", toggled by
   activeTodoTab). Every context needs unique element IDs since hidden
   panels stay in the DOM rather than being removed. */
const TODO_CONTEXTS = [
  { listType: 'daily', idPrefix: 'todayTab' },
  { listType: 'daily', idPrefix: 'daily' },
  { listType: 'long', idPrefix: 'long' }
];

/* ---------------------------------------------------------------------
   Render
------------------------------------------------------------------------ */

function render() {
  const root = document.getElementById('root');
  const todaysTotals = totalsFor(sessionsOn(new Date()));
  const streak = computeThinkGoalStreak();
  const bestStreak = computeBestThinkStreak();
  const quote = QUOTES[new Date().getDate() % QUOTES.length];
  const goal = goalMinutesOn(new Date());

  let elapsed = 0;
  if (timer.running) elapsed = Date.now() - timer.startedAt;

  const met = todaysTotals.think >= goal;
  const pct = Math.min(todaysTotals.think / goal, 1) * 100;
  const remaining = Math.max(goal - todaysTotals.think, 0);

  const weekDays = last7Days();
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  root.innerHTML = `
    <div class="top">
      <div class="brand">
        <h1>Field Notes</h1>
        <div class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
      </div>
      <div class="streak">
        <div class="num">${streak} ${streak === 1 ? 'day' : 'days'}</div>
        <div class="lbl">thinking streak</div>
      </div>
    </div>

    <div class="install-banner" id="installBanner">
      <span id="installBannerText"></span>
      <button class="btn primary" id="installBtn" style="display:none;">Install</button>
    </div>

    <div class="tabs">
      <button class="tab-btn ${activeTab === 'today' ? 'active' : ''}" data-tab="today">Today</button>
      <button class="tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">History</button>
      <button class="tab-btn ${activeTab === 'todo' ? 'active' : ''}" data-tab="todo">To-Do</button>
    </div>

    <div class="tab-panel ${activeTab === 'today' ? 'active' : ''}" data-panel="today">
      <div class="quote">"${quote}"</div>

      <div class="card goal-card ${met ? 'met' : ''}">
        <div class="goal-top">
          <h2 style="margin:0;">Core-problem thinking</h2>
          <span class="goal-status ${met ? 'met' : ''}">${met ? '✓ goal met today' : `${fmtHrs(remaining)} to go`}</span>
        </div>
        <div class="progress-outer"><div class="progress-inner ${met ? 'met' : ''}" style="width:${pct}%;"></div></div>
        <div class="goal-bottom">
          <div class="goal-stats">
            <div class="goal-stat"><div class="num">${fmtHrs(todaysTotals.think)} <span style="color:var(--muted); font-size:12px; font-weight:400;">/ ${fmtHrs(goal)}</span></div><div class="lbl">Today</div></div>
            <div class="goal-stat"><div class="num">${streak}</div><div class="lbl">Streak</div></div>
            <div class="goal-stat"><div class="num">${bestStreak}</div><div class="lbl">Best</div></div>
          </div>
          <div class="goal-edit">
            <label for="goalInput">Daily target (min)</label>
            <input type="number" id="goalInput" min="1" value="${goal}">
            <button class="btn" style="padding:5px 10px; font-size:11px;" id="saveGoalBtn">Save</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Track time</h2>
        <div class="cat-buttons">
          ${Object.keys(CATS).map((cat) => `
            <button class="cat-btn ${timer.running && timer.category === cat ? 'active' : ''}" data-cat="${cat}" ${timer.running && timer.category !== cat ? 'disabled' : ''}>
              <span class="cat-dot"></span>${CATS[cat].label}
            </button>`).join('')}
        </div>
        <div class="timer-display">
          <div class="clock">${fmtClock(elapsed)}</div>
          <div class="status">${timer.running ? CATS[timer.category].label + ' — in progress' : 'Not tracking'}</div>
        </div>
        <div class="timer-controls">
          <button class="btn stop" id="stopBtn" ${!timer.running ? 'disabled' : ''}>Stop &amp; log</button>
        </div>
        <div class="manual-add">
          <label>Add time manually:</label>
          <input type="number" id="manualMin" min="1" placeholder="min">
          <select id="manualCat">
            ${CAT_KEYS.map((k) => `<option value="${k}" ${k === 'think' ? 'selected' : ''}>${CATS[k].label}</option>`).join('')}
          </select>
          <button class="btn" id="manualAddBtn">Add</button>
        </div>
      </div>

      <div class="card">
        <h2>Today's dial</h2>
        <div class="dial-wrap">
          ${renderDial(todaysTotals)}
          <div class="dial-legend">
            ${Object.keys(CATS).map((cat) => `
              <div class="legend-row"><span class="cat-dot" style="background:${CATS[cat].hex}"></span>${CATS[cat].label}<span class="val">${fmtHrs(todaysTotals[cat])}</span></div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Today's dial</h2>
        <div class="dial-wrap">
          ${renderDial(todaysTotals)}
          <div class="dial-legend">
            ${Object.keys(CATS).map((cat) => `
              <div class="legend-row"><span class="cat-dot" style="background:${CATS[cat].hex}"></span>${CATS[cat].label}<span class="val">${fmtHrs(todaysTotals[cat])}</span></div>`).join('')}
          </div>
        </div>
      </div>

      ${renderTodoList('daily', 'todayTab', true, "Today's tasks")}
    </div>

    <div class="tab-panel ${activeTab === 'history' ? 'active' : ''}" data-panel="history">
      <div class="card">
        <h2>Last 7 days</h2>
        <div class="week-rows">
          ${weekDays.map((d) => {
            const totals = totalsFor(sessionsOn(d));
            const total = CAT_KEYS.reduce((sum, k) => sum + totals[k], 0);
            const scaleMin = 8 * 60;
            const pctOf = (cat) => Math.min(totals[cat] / scaleMin, 1) * 100;
            return `<div class="week-row">
              <span class="week-day">${dayLabels[d.getDay()]} ${d.getDate()}${todayStr(d) === todayStr() ? ' •' : ''}</span>
              <div class="week-bar">
                ${CAT_KEYS.map((cat) => `<div class="week-bar-seg" style="width:${pctOf(cat)}%;background:${CATS[cat].hex}"></div>`).join('')}
              </div>
              <span class="week-total">${fmtHrs(total)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="card">
        <h2>All-time</h2>
        ${(() => {
          const totalMin = sessions.reduce((sum, s) => sum + s.minutes, 0);
          const daysTracked = new Set(sessions.map((s) => s.date)).size;
          return `<div class="stat-row">
            <div><div class="num">${fmtHrs(totalMin)}</div><div class="lbl">Logged</div></div>
            <div><div class="num">${daysTracked}</div><div class="lbl">Days tracked</div></div>
            <div><div class="num">${bestStreak}</div><div class="lbl">Best streak</div></div>
          </div>`;
        })()}
      </div>

      <div class="card">
        <h2>Backup &amp; data</h2>
        <p style="font-size:12.5px; color:var(--muted); margin-top:0;">
          Export everything to a file you can move to another device, or hand off for your own analysis.
        </p>
        <div class="backup-row">
          <button class="btn" id="exportJsonBtn">Export JSON backup</button>
          <button class="btn" id="exportCsvBtn">Export CSV (for analysis)</button>
          <button class="btn" id="importBtn">Import backup</button>
          <input type="file" id="importFile" accept="application/json">
        </div>
        <div class="footer-note" style="text-align:left; margin-top:14px;">
          <button id="resetBtn">Clear all data</button>
        </div>
      </div>
    </div>

    <div class="tab-panel ${activeTab === 'todo' ? 'active' : ''}" data-panel="todo">
      <div class="todo-subtabs">
        <button class="tab-btn ${activeTodoTab === 'daily' ? 'active' : ''}" data-todotab="daily">Today</button>
        <button class="tab-btn ${activeTodoTab === 'long' ? 'active' : ''}" data-todotab="long">Backlog</button>
      </div>

      ${renderTodoList('daily', 'daily', activeTodoTab === 'daily')}
      ${renderTodoList('long', 'long', activeTodoTab === 'long')}
    </div>
  `;

  attachHandlers();
  updateInstallBanner();
}

/* ---------------------------------------------------------------------
   Event handlers
------------------------------------------------------------------------ */

function attachHandlers() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => { activeTab = btn.dataset.tab; render(); };
  });
  document.querySelectorAll('.cat-btn').forEach((btn) => {
    btn.onclick = () => onCatClick(btn.dataset.cat);
  });
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) stopBtn.onclick = stopTimer;

  const manualAddBtn = document.getElementById('manualAddBtn');
  if (manualAddBtn) manualAddBtn.onclick = onManualAdd;

  const saveGoalBtn = document.getElementById('saveGoalBtn');
  if (saveGoalBtn) saveGoalBtn.onclick = onSaveGoal;

  document.querySelectorAll('[data-todotab]').forEach((btn) => {
    btn.onclick = () => { activeTodoTab = btn.dataset.todotab; render(); };
  });

  TODO_CONTEXTS.forEach(({ listType, idPrefix }) => {
    const addBtn = document.getElementById(`${idPrefix}AddBtn`);
    const input = document.getElementById(`${idPrefix}TodoInput`);
    if (addBtn) addBtn.onclick = () => onAddTodo(listType, idPrefix);
    if (input) input.onkeydown = (e) => { if (e.key === 'Enter') onAddTodo(listType, idPrefix); };
  });

  document.querySelectorAll('.todo-check').forEach((el) => { el.onclick = () => toggleTodo(el.dataset.id); });
  document.querySelectorAll('.todo-del').forEach((el) => { el.onclick = () => deleteTodo(el.dataset.id); });

  const exportJsonBtn = document.getElementById('exportJsonBtn');
  if (exportJsonBtn) exportJsonBtn.onclick = exportJson;
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportCsvBtn) exportCsvBtn.onclick = exportCsv;
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  if (importBtn) importBtn.onclick = () => importFile.click();
  if (importFile) importFile.onchange = onImportFile;
  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.onclick = onReset;
}

async function onCatClick(cat) {
  if (timer.running) {
    if (timer.category === cat) await stopTimer();
    return;
  }
  timer = { running: true, category: cat, startedAt: Date.now() };
  saveTimerToLocalStorage();
  render();
}
async function stopTimer() {
  if (!timer.running) return;
  const elapsedMin = (Date.now() - timer.startedAt) / 60000;
  if (elapsedMin >= 0.5) {
    await addSession(timer.category, elapsedMin, 'timer');
  }
  timer = { running: false, category: null, startedAt: null };
  saveTimerToLocalStorage();
  render();
}
async function onManualAdd() {
  const min = parseFloat(document.getElementById('manualMin').value);
  const cat = document.getElementById('manualCat').value;
  if (!min || min <= 0) return;
  await addSession(cat, min, 'manual');
  render();
}
async function addSession(category, minutes, source) {
  const session = { id: uid(), date: todayStr(), category, minutes: Math.round(minutes), source, createdAt: Date.now() };
  sessions.push(session);
  await dbPut('sessions', session);
}
async function onSaveGoal() {
  const val = parseInt(document.getElementById('goalInput').value, 10);
  if (!val || val <= 0) return;
  const entry = { id: uid(), effectiveDate: todayStr(), thinkGoalMinutes: val, createdAt: Date.now() };
  goals.push(entry);
  await dbPut('goals', entry);
  render();
}
async function onAddTodo(listType, idPrefix) {
  const input = document.getElementById(`${idPrefix}TodoInput`);
  const select = document.getElementById(`${idPrefix}CategorySelect`);
  const text = input.value.trim();
  if (!text) return;
  const category = select.value || null;
  const todo = {
    id: uid(),
    text,
    isDone: false,
    category,
    linkedDate: listType === 'daily' ? todayStr() : null,
    createdAt: Date.now()
  };
  todos.push(todo);
  await dbPut('todos', todo);
  render();
  const fresh = document.getElementById(`${idPrefix}TodoInput`);
  if (fresh) fresh.focus();
}
async function toggleTodo(id) {
  const t = todos.find((t) => t.id === id);
  if (!t) return;
  t.isDone = !t.isDone;
  t.completedAt = t.isDone ? Date.now() : null;
  await dbPut('todos', t);
  render();
}
async function deleteTodo(id) {
  todos = todos.filter((t) => t.id !== id);
  await dbDelete('todos', id);
  render();
}

/* ---------------------------------------------------------------------
   Backup / export / import
------------------------------------------------------------------------ */

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function exportJson() {
  const payload = { exportedAt: new Date().toISOString(), sessions, todos, goals };
  downloadBlob(JSON.stringify(payload, null, 2), `field-notes-backup-${todayStr()}.json`, 'application/json');
}
function exportCsv() {
  let lines = ['date,category,minutes,source'];
  sessions.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((s) => {
    lines.push(`${s.date},${s.category},${s.minutes},${s.source}`);
  });
  downloadBlob(lines.join('\n'), `field-notes-sessions-${todayStr()}.csv`, 'text/csv');
}
async function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.sessions || !parsed.todos) throw new Error('Not a Field Notes backup file');
    if (!confirm('Import will replace all current data on this device with the backup. Continue?')) return;
    sessions = parsed.sessions || [];
    todos = parsed.todos || [];
    goals = parsed.goals || [];
    await dbClearAndFill('sessions', sessions);
    await dbClearAndFill('todos', todos);
    await dbClearAndFill('goals', goals);
    render();
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  } finally {
    e.target.value = '';
  }
}
async function onReset() {
  if (!confirm('Clear all tracked time, goals, and to-dos on this device? This cannot be undone.')) return;
  sessions = []; todos = []; goals = [];
  await dbClearAndFill('sessions', []);
  await dbClearAndFill('todos', []);
  await dbClearAndFill('goals', []);
  render();
}

/* ---------------------------------------------------------------------
   Install prompt (Android/Chrome native prompt; iOS gets instructions
   since Safari has no beforeinstallprompt event)
------------------------------------------------------------------------ */

let deferredInstallPrompt = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallBanner();
});

function updateInstallBanner() {
  const banner = document.getElementById('installBanner');
  const text = document.getElementById('installBannerText');
  const btn = document.getElementById('installBtn');
  if (!banner) return;
  if (isStandalone) { banner.classList.remove('show'); return; }

  if (deferredInstallPrompt) {
    text.textContent = 'Install Field Notes for full-screen, offline access.';
    btn.style.display = 'inline-block';
    btn.onclick = async () => {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      updateInstallBanner();
    };
    banner.classList.add('show');
  } else if (isIOS) {
    text.textContent = 'Add to Home Screen: tap Share, then "Add to Home Screen".';
    btn.style.display = 'none';
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

/* ---------------------------------------------------------------------
   Init
------------------------------------------------------------------------ */

let clockInterval = null;
function startClock() {
  clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    if (timer.running) {
      const el = document.querySelector('.clock');
      if (el) el.textContent = fmtClock(Date.now() - timer.startedAt);
    }
  }, 1000);
}

(async function init() {
  loadTimerFromLocalStorage();
  db = await openDB();
  [sessions, todos, goals] = await Promise.all([dbGetAll('sessions'), dbGetAll('todos'), dbGetAll('goals')]);
  if (goals.length === 0) {
    const seed = { id: uid(), effectiveDate: todayStr(), thinkGoalMinutes: 120, createdAt: Date.now() };
    goals.push(seed);
    await dbPut('goals', seed);
  }
  render();
  startClock();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
})();
