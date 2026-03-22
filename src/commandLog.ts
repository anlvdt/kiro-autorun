import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface CommandLogEntry {
  id: number;
  command: string;
  timestamp: string;
  reason: string;
  status: 'auto-approved' | 'denied' | 'manual';
}

const LOG_DIR = path.join(os.homedir(), '.kiro-autorun');
const LOG_FILE = 'history.json';

let entries: CommandLogEntry[] = [];
let nextId = 1;
let panel: vscode.WebviewPanel | undefined;

/**
 * Get the log file path (global, not workspace-dependent)
 */
function getLogFilePath(): string {
  return path.join(LOG_DIR, LOG_FILE);
}

/**
 * Load existing log entries from the workspace log file
 */
export function loadLog(): void {
  const logPath = getLogFilePath();
  if (!fs.existsSync(logPath)) {
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
 * Save log entries to the global log file
 */
function saveLog(): void {
  const logPath = getLogFilePath();
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

let panelRefreshInterval: ReturnType<typeof setInterval> | undefined;

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
    if (panelRefreshInterval) {
      clearInterval(panelRefreshInterval);
      panelRefreshInterval = undefined;
    }
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

  // Auto-refresh while panel is visible
  panelRefreshInterval = setInterval(() => {
    if (panel?.visible) {
      refreshPanel();
    }
  }, 5000);

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
  <title>Kiro AutoRun — Native Layer 0 Dashboard</title>
  <style>
    /* ── Premium Modern UI: Glassmorphism & Animations ── */
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --mono: 'JetBrains Mono', "SF Mono", "Cascadia Code", "Fira Code", monospace;
      
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --fg-dim: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      
      /* Vibrant Core Colors */
      --accent: #6366f1; /* Indigo */
      --accent-grad: linear-gradient(135deg, #6366f1, #a855f7);
      --accent-glow: rgba(99, 102, 241, 0.25);
      
      --emerald: #10b981;
      --emerald-bg: rgba(16, 185, 129, 0.12);
      
      --coral: #ef4444;
      --coral-bg: rgba(239, 68, 68, 0.12);
      
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.12);
      
      --surface: rgba(255, 255, 255, 0.03);
      --surface-hover: rgba(255, 255, 255, 0.06);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--sans);
      color: var(--fg);
      background: var(--bg);
      padding: 32px;
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      /* Subtle radial gradient background */
      background-image: radial-gradient(circle at 100% 0%, var(--accent-glow) 0%, transparent 40%);
      background-attachment: fixed;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      width: 150px;
      height: 2px;
      background: var(--accent-grad);
      box-shadow: 0 0 10px var(--accent-glow);
      border-radius: 2px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo-box {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--accent-grad);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 16px var(--accent-glow);
      color: white;
    }
    .logo-box svg { width: 24px; height: 24px; }
    
    .title-wrapper {
      display: flex;
      flex-direction: column;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--fg);
    }
    .subtitle {
      font-size: 12px;
      color: var(--fg-dim);
      font-weight: 500;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .layer-badge {
      background: rgba(255,255,255,0.1);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      color: var(--fg);
    }

    /* Status Pulse */
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--surface);
      padding: 8px 16px;
      border-radius: 20px;
      border: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      color: var(--emerald);
    }
    .pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4);
      animation: pulse-ring 2s infinite cubic-bezier(0.215, 0.61, 0.355, 1);
    }
    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
      70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* ── Stats Glass Cards ── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .stat-card {
      padding: 24px;
      border-radius: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    .stat-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.15);
      border-color: rgba(255, 255, 255, 0.15);
    }
    
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--fg-dim);
      opacity: 0.3;
      transition: opacity 0.3s;
    }
    .stat-card.total::before { background: var(--accent-grad); opacity: 1; }
    .stat-card.approved::before { background: var(--emerald); opacity: 1; }
    .stat-card.denied::before { background: var(--coral); opacity: 1; }

    .stat-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stat-icon {
      width: 18px;
      height: 18px;
      opacity: 0.7;
    }
    .stat-card.total .stat-icon { color: var(--accent); }
    .stat-card.approved .stat-icon { color: var(--emerald); }
    .stat-card.denied .stat-icon { color: var(--coral); }

    .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
      color: var(--fg-dim);
    }
    .stat-value {
      font-size: 36px;
      font-weight: 700;
      line-height: 1;
      font-family: var(--sans);
      letter-spacing: -1px;
    }

    /* ── Controls ── */
    .controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .filter-group {
      display: inline-flex;
      background: rgba(0,0,0,0.2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px;
      gap: 4px;
    }
    .filter-btn {
      padding: 8px 16px;
      border: none;
      background: transparent;
      color: var(--fg-dim);
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .filter-btn:hover {
      color: var(--fg);
      background: var(--surface-hover);
    }
    .filter-btn.active {
      color: var(--fg);
      background: var(--surface);
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    
    .btn-danger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      font-family: var(--sans);
      font-weight: 500;
      font-size: 12px;
      cursor: pointer;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .btn-danger:hover {
      background: var(--coral-bg);
      border-color: rgba(239, 68, 68, 0.3);
      color: var(--coral);
    }
    .btn-icon { width: 14px; height: 14px; }

    /* ── Table Container ── */
    .table-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      backdrop-filter: blur(10px);
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    
    th {
      padding: 16px 20px;
      background: rgba(0,0,0,0.2);
      color: var(--fg-dim);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid var(--border);
    }
    
    td {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      vertical-align: middle;
      font-family: var(--sans);
      font-size: 13px;
    }
    
    tr {
      transition: background 0.2s;
      animation: slideIn 0.3s ease-out forwards;
      opacity: 0;
      transform: translateY(10px);
    }
    tr:nth-child(1) { animation-delay: 0.05s; }
    tr:nth-child(2) { animation-delay: 0.1s; }
    tr:nth-child(3) { animation-delay: 0.15s; }
    tr:nth-child(4) { animation-delay: 0.2s; }
    tr:nth-child(5) { animation-delay: 0.25s; }
    tr:nth-child(n+6) { animation-delay: 0.3s; }
    
    @keyframes slideIn {
      to { opacity: 1; transform: translateY(0); }
    }
    
    tr:hover { background: var(--surface-hover); }
    tr:last-child td { border-bottom: none; }

    /* Column Specifics */
    .col-id { width: 60px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
    .col-time { width: 140px; }
    .time-date { color: var(--fg-dim); font-size: 12px; display: block; margin-bottom: 2px; }
    .time-clock { color: var(--fg); font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 11px;}
    
    .col-cmd { max-width: 400px; }
    .cmd-wrap {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .cmd-wrap code {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--fg);
      background: rgba(0,0,0,0.2);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.05);
      word-break: break-all;
    }
    
    .copy-btn {
      background: rgba(255,255,255,0.05);
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px;
      color: var(--fg-dim);
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.1); color: var(--fg); transform: scale(1.05); }
    .copy-btn:active { transform: scale(0.95); }
    .copy-icon, .copy-done { width: 14px; height: 14px; }
    .copy-done { display: none; color: var(--emerald); }
    .copy-btn.copied .copy-icon { display: none; }
    .copy-btn.copied .copy-done { display: block; }
    .copy-btn.copied { background: var(--emerald-bg); border-color: rgba(16, 185, 129, 0.3); }

    .col-status { width: 140px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-icon { width: 14px; height: 14px; }
    .badge-auto-approved { background: var(--emerald-bg); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.2); }
    .badge-denied { background: var(--coral-bg); color: var(--coral); border: 1px solid rgba(239, 68, 68, 0.2); }
    .badge-manual { background: var(--amber-bg); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.2); }

    .col-reason { color: var(--fg-dim); line-height: 1.4; }

    /* ── Empty State ── */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 12px;
      margin-top: 20px;
    }
    .empty-icon {
      width: 48px;
      height: 48px;
      color: var(--accent);
      opacity: 0.5;
      margin-bottom: 20px;
      filter: drop-shadow(0 0 10px var(--accent-glow));
    }
    .empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--fg);
      margin-bottom: 8px;
    }
    .empty-hint {
      color: var(--fg-dim);
      font-size: 13px;
    }

    /* Filter hiding */
    .row.hidden { display: none; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="logo-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
      </div>
      <div class="title-wrapper">
        <div class="title">Native API Dashboard</div>
        <div class="subtitle">
           <span class="layer-badge">Layer 0</span> TS Execution Active • No OCR Tracking
        </div>
      </div>
    </div>
    <div class="status-indicator">
      <span class="pulse"></span> Auto-Approver Listening
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card total">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        <span class="stat-label">Total Execution Ops</span>
      </div>
      <div class="stat-value">${entries.length}</div>
    </div>
    <div class="stat-card approved">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
        <span class="stat-label">Native Approved</span>
      </div>
      <div class="stat-value">${approvedCount}</div>
    </div>
    <div class="stat-card denied">
      <div class="stat-header">
        <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
        <span class="stat-label">Banned / Denied</span>
      </div>
      <div class="stat-value">${deniedCount}</div>
    </div>
  </div>

  ${entries.length === 0 ? emptyState : `
  <div class="controls">
    <div class="filter-group">
      <button class="filter-btn active" data-filter="all" onclick="filterRows('all', this)">All Ops</button>
      <button class="filter-btn" data-filter="auto-approved" onclick="filterRows('auto-approved', this)">Approved</button>
      <button class="filter-btn" data-filter="denied" onclick="filterRows('denied', this)">Denied</button>
      ${manualCount > 0 ? '<button class="filter-btn" data-filter="manual" onclick="filterRows(\'manual\', this)">Manual</button>' : ''}
    </div>
    <button class="btn-danger" onclick="clearAll()">
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      Clear Log
    </button>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Timestamp</th>
          <th>Execution Command</th>
          <th>Resolution</th>
          <th>Detail</th>
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
      setTimeout(() => btn.classList.remove('copied'), 2000);
    }

    function clearAll() {
      if (confirm('Clear all native execution history?')) {
        vscode.postMessage({ command: 'clear' });
      }
    }

    function filterRows(status, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
