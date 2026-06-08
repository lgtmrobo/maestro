/**
 * Dark-mode multi-lane dashboard. SSR'd HTML with vanilla JS + SSE for live
 * updates. No build step.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Maestro</title>
<style>
  :root {
    --bg: #0b0d10;
    --bg-elev: #14181d;
    --bg-hi: #1b2027;
    --border: #232932;
    --fg: #e6e8eb;
    --fg-dim: #9ba3ad;
    --fg-faint: #6b7480;
    --accent: #7aa2f7;
    --green: #9ece6a;
    --yellow: #e0af68;
    --red: #f7768e;
    --purple: #bb9af7;
    --cyan: #7dcfff;
    --mono: ui-monospace, SF Mono, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 16px;
    background: var(--bg-elev);
    position: sticky; top: 0; z-index: 1;
  }
  header h1 {
    margin: 0;
    font-size: 16px; font-weight: 600;
    letter-spacing: 0.02em;
  }
  header .subtitle { color: var(--fg-dim); font-size: 13px; }
  header .stats { margin-left: auto; display: flex; gap: 18px; font-family: var(--mono); font-size: 12px; color: var(--fg-dim); }
  header .stats b { color: var(--fg); font-weight: 600; }
  header .pulse {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--green); margin-right: 6px;
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(158,206,106,0.6); }
    70% { box-shadow: 0 0 0 8px rgba(158,206,106,0); }
    100% { box-shadow: 0 0 0 0 rgba(158,206,106,0); }
  }
  main { padding: 24px; display: grid; gap: 24px; }
  .lane {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .lane h2 {
    margin: 0; padding: 14px 18px;
    font-size: 14px; font-weight: 600;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
    background: var(--bg-hi);
  }
  .lane h2 .badge {
    font-family: var(--mono); font-size: 11px;
    padding: 2px 7px; border-radius: 4px;
    background: var(--bg); color: var(--fg-dim);
    border: 1px solid var(--border);
    font-weight: 500;
  }
  .lane h2 .lane-stats { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--fg-dim); font-weight: 400; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 10px 18px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  thead th {
    color: var(--fg-faint);
    font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em;
    font-size: 11px; background: var(--bg-elev);
  }
  tbody tr:last-child td { border-bottom: none; }
  td.id { font-family: var(--mono); color: var(--accent); font-weight: 500; }
  td.title { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.state { font-family: var(--mono); font-size: 12px; }
  td.state .pill {
    display: inline-block; padding: 2px 8px; border-radius: 3px;
    background: var(--bg); border: 1px solid var(--border);
    color: var(--fg-dim); font-weight: 500;
  }
  td.state .pill.running { color: var(--green); border-color: rgba(158,206,106,0.35); }
  td.state .pill.retry { color: var(--yellow); border-color: rgba(224,175,104,0.35); }
  td.tokens, td.age, td.event { font-family: var(--mono); color: var(--fg-dim); font-size: 12px; }
  td.event { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty {
    padding: 24px 18px; color: var(--fg-faint);
    font-style: italic; text-align: center;
  }
  td.outcome .pill.normal { color: var(--green); border-color: rgba(158,206,106,0.35); }
  td.outcome .pill.error  { color: var(--red);   border-color: rgba(247,118,142,0.35); }
  td.outcome .pill.cancelled { color: var(--yellow); border-color: rgba(224,175,104,0.35); }
  tbody tr.clickable { cursor: pointer; }
  tbody tr.clickable:hover { background: var(--bg-hi); }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: none; z-index: 10; align-items: flex-start; justify-content: center;
    overflow-y: auto; padding: 40px 20px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 8px; max-width: 980px; width: 100%;
    color: var(--fg); padding: 0; overflow: hidden;
  }
  .modal-head {
    padding: 14px 18px; border-bottom: 1px solid var(--border);
    background: var(--bg-hi);
    display: flex; align-items: center; gap: 12px;
  }
  .modal-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .modal-head .id { font-family: var(--mono); color: var(--accent); }
  .modal-head .close {
    margin-left: auto; background: none; border: 1px solid var(--border);
    color: var(--fg-dim); padding: 4px 10px; border-radius: 4px;
    cursor: pointer; font-family: var(--mono); font-size: 12px;
  }
  .modal-head .close:hover { color: var(--fg); background: var(--bg); }
  .modal-body { padding: 18px; }
  .modal-body section { margin-bottom: 22px; }
  .modal-body section h4 {
    margin: 0 0 8px 0; font-size: 11px; font-weight: 600;
    color: var(--fg-faint); text-transform: uppercase; letter-spacing: 0.06em;
  }
  .modal-body pre {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 12px; margin: 0;
    font-family: var(--mono); font-size: 12px;
    color: var(--fg); white-space: pre-wrap; word-break: break-word;
    max-height: 360px; overflow-y: auto;
  }
  .modal-body .kv { font-family: var(--mono); font-size: 12px; color: var(--fg-dim); }
  .modal-body .kv b { color: var(--fg); }
  .modal-body .kv span { display: inline-block; margin-right: 18px; }
  footer {
    padding: 16px 24px; color: var(--fg-faint); font-size: 12px;
    text-align: center; font-family: var(--mono);
    border-top: 1px solid var(--border);
  }
</style>
</head>
<body>
<header>
  <h1><span class="pulse"></span>Maestro</h1>
  <span class="subtitle">Issue Orchestration Dashboard</span>
  <div class="stats">
    <span><b id="stat-running">0</b> running</span>
    <span><b id="stat-retry">0</b> retrying</span>
    <span><b id="stat-completed">0</b> completed</span>
    <span><b id="stat-tokens">0</b> tokens</span>
  </div>
</header>
<main>
  <div id="lanes"></div>
  <section class="lane">
    <h2>Past runs <span class="lane-stats">most recent 50</span></h2>
    <div id="past-runs"></div>
  </section>
</main>

<div id="trace-modal" class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-head">
      <h3 id="trace-modal-title">Trace</h3>
      <span class="id" id="trace-modal-id"></span>
      <button class="close" id="trace-modal-close">close</button>
    </div>
    <div class="modal-body" id="trace-modal-body"></div>
  </div>
</div>

<footer>Maestro v0.1 · live SSE feed · <span id="last-update">connecting…</span></footer>

<script>
const lanesEl = document.getElementById('lanes');
const pastRunsEl = document.getElementById('past-runs');
const modalEl = document.getElementById('trace-modal');
const modalBodyEl = document.getElementById('trace-modal-body');
const modalIdEl = document.getElementById('trace-modal-id');
const modalTitleEl = document.getElementById('trace-modal-title');
document.getElementById('trace-modal-close').addEventListener('click', () => modalEl.classList.remove('open'));
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) modalEl.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modalEl.classList.remove('open'); });
const stats = {
  running: document.getElementById('stat-running'),
  retry: document.getElementById('stat-retry'),
  completed: document.getElementById('stat-completed'),
  tokens: document.getElementById('stat-tokens'),
  lastUpdate: document.getElementById('last-update'),
};

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n / 1000) + 'K';
}

function age(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

function render(state) {
  let totalRunning = 0, totalRetry = 0, totalCompleted = 0, totalTokens = 0;
  lanesEl.innerHTML = '';

  for (const lane of state.lanes) {
    totalRunning += lane.running.length;
    totalRetry += lane.retries.length;
    totalCompleted += lane.completedCount;
    for (const r of lane.running) totalTokens += r.tokenUsage.totalTokens;

    const sec = document.createElement('section');
    sec.className = 'lane';

    const labelsBadge = lane.requiredLabels.length
      ? '<span class="badge">' + lane.requiredLabels.join(', ') + '</span>'
      : '';

    const slotsBadge = '<span class="badge">' + lane.running.length + '/' + lane.maxConcurrent + ' slots</span>';
    const backendBadge = '<span class="badge">' + lane.backend + '</span>';

    sec.innerHTML =
      '<h2>' + lane.name +
        labelsBadge + slotsBadge + backendBadge +
        '<span class="lane-stats">' + lane.completedCount + ' done · ' + lane.retries.length + ' retrying</span>' +
      '</h2>';

    if (lane.running.length === 0 && lane.retries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No active work';
      sec.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.innerHTML =
        '<thead><tr>' +
          '<th>ID</th>' +
          '<th>Title</th>' +
          '<th>State</th>' +
          '<th>Age</th>' +
          '<th>Tokens</th>' +
          '<th>Last event</th>' +
        '</tr></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');

      for (const r of lane.running) {
        const tr = document.createElement('tr');
        if (r.traceId) {
          tr.className = 'clickable';
          tr.addEventListener('click', () => openTrace(r.traceId));
        }
        tr.innerHTML =
          '<td class="id">' + r.identifier + '</td>' +
          '<td class="title">' + escapeHtml(r.title) + '</td>' +
          '<td class="state"><span class="pill running">running</span></td>' +
          '<td class="age">' + age(r.startedAt) + '</td>' +
          '<td class="tokens">' + fmtTokens(r.tokenUsage.totalTokens) + '</td>' +
          '<td class="event">' + escapeHtml(r.lastEvent || '—') + '</td>';
        tbody.appendChild(tr);
      }
      for (const r of lane.retries) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="id">' + r.identifier + '</td>' +
          '<td class="title">' + escapeHtml(r.title) + '</td>' +
          '<td class="state"><span class="pill retry">retry attempt ' + r.attempt + '</span></td>' +
          '<td class="age">in ' + Math.max(0, Math.round((new Date(r.scheduledAt).getTime() - Date.now()) / 1000)) + 's</td>' +
          '<td class="tokens">—</td>' +
          '<td class="event">' + escapeHtml(r.reason || '—') + '</td>';
        tbody.appendChild(tr);
      }
      sec.appendChild(table);
    }

    lanesEl.appendChild(sec);
  }

  stats.running.textContent = totalRunning;
  stats.retry.textContent = totalRetry;
  stats.completed.textContent = totalCompleted;
  stats.tokens.textContent = fmtTokens(totalTokens);
  stats.lastUpdate.textContent = 'updated ' + new Date().toLocaleTimeString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();
    render(state);
  } catch (err) {
    stats.lastUpdate.textContent = 'connection lost';
  }
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0') + 's';
}

function outcomePill(o) {
  if (o == null) return '<span class="pill">running</span>';
  return '<span class="pill ' + o + '">' + o + '</span>';
}

async function refreshPastRuns() {
  try {
    const res = await fetch('/api/traces?limit=50');
    const { traces } = await res.json();
    pastRunsEl.innerHTML = '';
    if (!traces || traces.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No completed runs yet';
      pastRunsEl.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.innerHTML =
      '<thead><tr>' +
        '<th>ID</th><th>Lane</th><th>Title</th><th>Outcome</th>' +
        '<th>Started</th><th>Duration</th><th>Tokens</th><th>Attempt</th>' +
      '</tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    for (const t of traces) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', () => openTrace(t.traceId));
      tr.innerHTML =
        '<td class="id">' + escapeHtml(t.ticket.identifier) + '</td>' +
        '<td class="event">' + escapeHtml(t.laneName) + '</td>' +
        '<td class="title">' + escapeHtml(t.ticket.title) + '</td>' +
        '<td class="outcome">' + outcomePill(t.outcome) + '</td>' +
        '<td class="age">' + new Date(t.startedAt).toLocaleString() + '</td>' +
        '<td class="age">' + fmtDuration(t.durationMs) + '</td>' +
        '<td class="tokens">' + (t.totalTokens != null ? fmtTokens(t.totalTokens) : '—') + '</td>' +
        '<td class="age">' + t.attempt + '</td>';
      tbody.appendChild(tr);
    }
    pastRunsEl.appendChild(table);
  } catch {
    // ignore
  }
}

async function openTrace(traceId) {
  modalIdEl.textContent = traceId;
  modalBodyEl.innerHTML = '<div class="empty">Loading…</div>';
  modalEl.classList.add('open');
  try {
    const res = await fetch('/api/trace/' + encodeURIComponent(traceId));
    if (!res.ok) {
      modalBodyEl.innerHTML = '<div class="empty">Trace not found</div>';
      return;
    }
    const r = await res.json();
    modalTitleEl.textContent = r.ticket.identifier + ' · ' + r.laneName + ' · attempt ' + r.attempt;
    const kv =
      '<div class="kv">' +
        '<span><b>backend:</b> ' + escapeHtml(r.backend) + '</span>' +
        '<span><b>outcome:</b> ' + (r.result?.outcome ?? 'running') + '</span>' +
        '<span><b>stop:</b> ' + escapeHtml(r.result?.stopReason ?? '—') + '</span>' +
        '<span><b>duration:</b> ' + fmtDuration(r.result?.durationMs) + '</span>' +
        '<span><b>tokens:</b> ' + (r.result?.tokenUsage ? fmtTokens(r.result.tokenUsage.totalTokens) : '—') + '</span>' +
        '<span><b>session:</b> ' + escapeHtml(r.sessionId ?? '—') + '</span>' +
      '</div>';
    const ticket = r.ticket.url
      ? '<a href="' + escapeHtml(r.ticket.url) + '" target="_blank" style="color:var(--accent);text-decoration:none">' + escapeHtml(r.ticket.identifier) + ' — ' + escapeHtml(r.ticket.title) + '</a>'
      : escapeHtml(r.ticket.identifier + ' — ' + r.ticket.title);
    modalBodyEl.innerHTML =
      '<section><h4>Ticket</h4><div class="kv">' + ticket + '</div></section>' +
      '<section><h4>Run</h4>' + kv + '</section>' +
      (r.result?.errorMessage ? '<section><h4>Error</h4><pre>' + escapeHtml(r.result.errorMessage) + '</pre></section>' : '') +
      '<section><h4>Rendered prompt</h4><pre>' + escapeHtml(r.renderedPrompt) + '</pre></section>' +
      '<section><h4>Custom tools (Maestro-injected)</h4><pre>' + escapeHtml(JSON.stringify(r.customTools, null, 2)) + '</pre></section>' +
      '<section><h4>Backend options (secrets redacted)</h4><pre>' + escapeHtml(JSON.stringify(r.backendOptions, null, 2)) + '</pre></section>' +
      (r.transcriptPath ? '<section><h4>SDK transcript path</h4><pre>' + escapeHtml(r.transcriptPath) + '</pre></section>' : '');
  } catch (err) {
    modalBodyEl.innerHTML = '<div class="empty">Failed to load trace</div>';
  }
}

refresh();
refreshPastRuns();
const evt = new EventSource('/api/events');
evt.onmessage = () => { refresh(); refreshPastRuns(); };
evt.onerror = () => { stats.lastUpdate.textContent = 'reconnecting…'; };
setInterval(() => { refresh(); refreshPastRuns(); }, 3000);
</script>
</body>
</html>`;
