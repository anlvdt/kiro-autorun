import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CommandLogEntry {
  id: number;
  command: string;
  timestamp: string;
  reason: string;
  status: 'auto-approved' | 'denied' | 'manual';
}

const LOG_DIR = '.kiro-autorun';
const LOG_FILE = 'history.json';

let entries: CommandLogEntry[] = [];
let nextId = 1;
let panel: vscode.WebviewPanel | undefined;

/**
 * Get the log file path for the current workspace
 */
function getLogFilePath(): string | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }
  return path.join(workspaceFolder.uri.fsPath, LOG_DIR, LOG_FILE);
}

/**
 * Load existing log entries from the workspace log file
 */
export function loadLog(): void {
  const logPath = getLogFilePath();
  if (!logPath || !fs.existsSync(logPath)) {
    entries = [];
    nextId = 1;
    return;
  }
  try {
    const data = fs.readFileSync(logPath, 'utf-8');
    entries = JSON.parse(data);
    nextId = entries.length > 0 ? Math.max(...entries.map((e) => e.id)) + 1 : 1;
  } catch {
    entries = [];
    nextId = 1;
  }
}

/**
 * Save log entries to the workspace log file
 */
function saveLog(): void {
  const logPath = getLogFilePath();
  if (!logPath) {
    return;
  }
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Add a new entry to the command log
 */
export function addEntry(
  command: string,
  reason: string,
  status: CommandLogEntry['status']
): CommandLogEntry {
  const entry: CommandLogEntry = {
    id: nextId++,
    command,
    timestamp: new Date().toISOString(),
    reason,
    status,
  };
  entries.push(entry);
  saveLog();
  refreshPanel();
  return entry;
}

/**
 * Clear all log entries
 */
export function clearLog(): void {
  entries = [];
  nextId = 1;
  saveLog();
  refreshPanel();
}

/**
 * Get all log entries
 */
export function getEntries(): CommandLogEntry[] {
  return [...entries];
}

/**
 * Get count of auto-approved entries
 */
export function getAutoApprovedCount(): number {
  return entries.filter((e) => e.status === 'auto-approved').length;
}

/**
 * Show the command history webview panel
 */
export function showLogPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Two);
    refreshPanel();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'kiroAutorunLog',
    '⚡ Kiro AutoRun History',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage((message) => {
    switch (message.command) {
      case 'copy':
        vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage('Command copied to clipboard');
        break;
      case 'clear':
        clearLog();
        vscode.window.showInformationMessage('Command history cleared');
        break;
    }
  });

  refreshPanel();
}

/**
 * Refresh the webview panel content
 */
function refreshPanel(): void {
  if (!panel) {
    return;
  }
  panel.webview.html = getWebviewContent();
}

/**
 * Generate the HTML content for the log webview
 */
function getWebviewContent(): string {
  const approvedCount = entries.filter((e) => e.status === 'auto-approved').length;
  const deniedCount = entries.filter((e) => e.status === 'denied').length;
  const manualCount = entries.filter((e) => e.status === 'manual').length;

  const rows = entries
    .slice()
    .reverse()
    .map(
      (entry) => {
        const statusSvg = entry.status === 'auto-approved'
          ? '<svg class="badge-icon badge-icon-ok" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3.5-3.5"/></svg>'
          : entry.status === 'denied'
            ? '<svg class="badge-icon badge-icon-deny" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>'
            : '<svg class="badge-icon badge-icon-manual" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.5"/></svg>';
        const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
        const dateStr = new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `
      <tr class="row" data-status="${entry.status}">
        <td class="col-id"><span class="id-num">${entry.id}</span></td>
        <td class="col-time">
          <span class="time-date">${escapeHtml(dateStr)}</span>
          <span class="time-clock">${escapeHtml(timeStr)}</span>
        </td>
        <td class="col-cmd">
          <div class="cmd-wrap">
            <code>${escapeHtml(entry.command)}</code>
            <button class="copy-btn" onclick="copyCmd(this, '${escapeJs(entry.command)}')" title="Copy command">
              <svg class="copy-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 014.5 2H11"/></svg>
              <svg class="copy-done" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.5 3.5L13 5"/></svg>
            </button>
          </div>
        </td>
        <td class="col-status">
          <span class="badge badge-${entry.status}">
            ${statusSvg}
            ${entry.status === 'auto-approved' ? 'APPROVED' : entry.status === 'denied' ? 'DENIED' : 'MANUAL'}
          </span>
        </td>
        <td class="col-reason">${escapeHtml(entry.reason)}</td>
      </tr>`;
      }
    )
    .join('');

  const emptyState = `
    <div class="empty-state">
      <svg class="empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="6" y="10" width="36" height="28" rx="3"/>
        <path d="M6 22l12 8 6-4 6 4 12-8"/>
        <circle cx="24" cy="32" r="2"/>
      </svg>
      <p class="empty-title">Awaiting Input</p>
      <p class="empty-hint">Commands will appear as Kiro processes them.</p>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kiro AutoRun — Ops Monitor</title>
  <style>
    /* ── Design System: Industrial Utilitarian / Terminal-Ops ── */
    :root {
      --mono: "JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code", monospace;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --fg-dim: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --surface: var(--vscode-sideBar-background, rgba(255,255,255,0.03));

      /* Signal colors */
      --emerald: #3fb950;
      --emerald-bg: rgba(63, 185, 80, 0.08);
      --emerald-glow: rgba(63, 185, 80, 0.15);
      --coral: #f85149;
      --coral-bg: rgba(248, 81, 73, 0.08);
      --coral-glow: rgba(248, 81, 73, 0.15);
      --amber: #d29922;
      --amber-bg: rgba(210, 153, 34, 0.08);
      --cyan: #58a6ff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--mono);
      color: var(--fg);
      background: var(--bg);
      padding: 20px;
      font-size: 12px;
      line-height: 1.5;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo {
      width: 22px;
      height: 22px;
      color: var(--cyan);
      flex-shrink: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .title-sub {
      font-size: 10px;
      color: var(--fg-dim);
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .pulse {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--emerald);
      animation: pulse-glow 2s ease-in-out infinite;
    }
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 0 0 var(--emerald-glow); }
      50% { box-shadow: 0 0 0 6px transparent; }
    }

    /* ── Stats Cards ── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .stat-card:hover {
      border-color: var(--fg-dim);
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
    }
    .stat-card.total::before { background: var(--cyan); }
    .stat-card.approved::before { background: var(--emerald); }
    .stat-card.denied::before { background: var(--coral); }
    .stat-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .stat-icon {
      width: 14px;
      height: 14px;
      opacity: 0.5;
    }
    .stat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--fg-dim);
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1;
    }
    .stat-card.total .stat-value { color: var(--cyan); }
    .stat-card.approved .stat-value { color: var(--emerald); }
    .stat-card.denied .stat-value { color: var(--coral); }

    /* ── Controls ── */
    .controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 8px;
    }
    .filter-group {
      display: flex;
      gap: 2px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px;
    }
    .filter-btn {
      padding: 5px 12px;
      border: none;
      background: transparent;
      color: var(--fg-dim);
      font-family: var(--mono);
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
      transition: all 0.15s;
      letter-spacing: 0.3px;
    }
    .filter-btn:hover {
      color: var(--fg);
      background: rgba(255,255,255,0.05);
    }
    .filter-btn.active {
      color: var(--fg);
      background: rgba(255,255,255,0.08);
    }
    .btn-danger {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border: 1px solid rgba(248, 81, 73, 0.3);
      background: var(--coral-bg);
      color: var(--coral);
      font-family: var(--mono);
      font-size: 11px;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .btn-icon {
      width: 13px;
      height: 13px;
    }
    .btn-danger:hover {
      background: rgba(248, 81, 73, 0.15);
      border-color: var(--coral);
    }

    /* ── Table ── */
    .table-wrap {
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      text-align: left;
      padding: 10px 12px;
      background: var(--surface);
      color: var(--fg-dim);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid var(--border);
    }
    tbody tr {
      transition: background 0.1s;
    }
    tbody tr:hover {
      background: rgba(255,255,255,0.02);
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      vertical-align: middle;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }

    /* Column styles */
    .col-id { width: 48px; }
    .id-num {
      color: var(--fg-dim);
      font-size: 11px;
    }
    .col-time { width: 130px; white-space: nowrap; }
    .time-date {
      color: var(--fg-dim);
      font-size: 11px;
    }
    .time-clock {
      color: var(--fg);
      margin-left: 6px;
    }
    .col-cmd { max-width: 350px; }
    .cmd-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cmd-wrap code {
      background: rgba(255,255,255,0.05);
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 12px;
      word-break: break-all;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .copy-btn {
      background: none;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 13px;
      padding: 2px 5px;
      opacity: 0.3;
      transition: all 0.15s;
      border-radius: 3px;
      color: var(--fg);
      position: relative;
      flex-shrink: 0;
    }
    .copy-btn:hover {
      opacity: 0.8;
      border-color: var(--border);
      background: rgba(255,255,255,0.05);
    }
    .copy-btn .copy-icon,
    .copy-btn .copy-done {
      width: 14px;
      height: 14px;
      display: block;
    }
    .copy-btn .copy-done {
      display: none;
      color: var(--emerald);
    }
    .copy-btn.copied .copy-icon { display: none; }
    .copy-btn.copied .copy-done { display: block; }
    .copy-btn.copied { opacity: 1; }

    .col-status { width: 110px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    .badge-icon {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
    }
    .badge-icon-ok { color: var(--emerald); }
    .badge-icon-deny { color: var(--coral); }
    .badge-icon-manual { color: var(--amber); }
    .badge-auto-approved {
      background: var(--emerald-bg);
      color: var(--emerald);
      border: 1px solid rgba(63, 185, 80, 0.2);
    }
    .badge-denied {
      background: var(--coral-bg);
      color: var(--coral);
      border: 1px solid rgba(248, 81, 73, 0.2);
    }
    .badge-manual {
      background: var(--amber-bg);
      color: var(--amber);
      border: 1px solid rgba(210, 153, 34, 0.2);
    }
    .col-reason {
      color: var(--fg-dim);
      font-size: 11px;
    }

    /* ── Empty State ── */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
    }
    .empty-icon {
      width: 64px;
      height: 64px;
      color: var(--fg-dim);
      opacity: 0.25;
      margin-bottom: 16px;
    }
    .empty-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--fg-dim);
      opacity: 0.6;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .empty-hint {
      color: var(--fg-dim);
      font-size: 11px;
      opacity: 0.4;
    }

    /* ── Row filter animation ── */
    .row.hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      <div>
        <div class="title">Kiro AutoRun</div>
        <div class="title-sub">Ops Monitor</div>
      </div>
    </div>
    <span class="pulse" title="Monitoring active"></span>
  </div>

  <div class="stats-grid">
    <div class="stat-card total">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/></svg>
        <div class="stat-label">Total Commands</div>
      </div>
      <div class="stat-value">${entries.length}</div>
    </div>
    <div class="stat-card approved">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3.5-3.5"/></svg>
        <div class="stat-label">Approved</div>
      </div>
      <div class="stat-value">${approvedCount}</div>
    </div>
    <div class="stat-card denied">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>
        <div class="stat-label">Denied</div>
      </div>
      <div class="stat-value">${deniedCount}</div>
    </div>
  </div>

  ${entries.length === 0 ? emptyState : `
  <div class="controls">
    <div class="filter-group">
      <button class="filter-btn active" data-filter="all" onclick="filterRows('all', this)">ALL</button>
      <button class="filter-btn" data-filter="auto-approved" onclick="filterRows('auto-approved', this)">APPROVED</button>
      <button class="filter-btn" data-filter="denied" onclick="filterRows('denied', this)">DENIED</button>
      ${manualCount > 0 ? '<button class="filter-btn" data-filter="manual" onclick="filterRows(\'manual\', this)">MANUAL</button>' : ''}
    </div>
    <button class="btn-danger" onclick="clearAll()"><svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 4h10M6 4V2.5A.5.5 0 016.5 2h3a.5.5 0 01.5.5V4M4.5 4l.7 9.5a1 1 0 001 .9h3.6a1 1 0 001-.9L11.5 4"/></svg> Clear</button>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Command</th>
          <th>Status</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  `}

  <script>
    const vscode = acquireVsCodeApi();

    function copyCmd(btn, text) {
      vscode.postMessage({ command: 'copy', text: text });
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    }

    function clearAll() {
      if (confirm('Clear all command history?')) {
        vscode.postMessage({ command: 'clear' });
      }
    }

    function filterRows(status, btn) {
      // Update active button
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Filter rows
      document.querySelectorAll('.row').forEach(row => {
        if (status === 'all' || row.dataset.status === status) {
          row.classList.remove('hidden');
        } else {
          row.classList.add('hidden');
        }
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
