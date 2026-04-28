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
<main id="lanes"></main>
<footer>Maestro v0.1 · live SSE feed · <span id="last-update">connecting…</span></footer>

<script>
const lanesEl = document.getElementById('lanes');
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

refresh();
const evt = new EventSource('/api/events');
evt.onmessage = () => refresh();
evt.onerror = () => { stats.lastUpdate.textContent = 'reconnecting…'; };
setInterval(refresh, 3000);
</script>
</body>
</html>`;
