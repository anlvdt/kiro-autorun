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
    const rows = entries
        .slice()
        .reverse()
        .map(
            (entry) => `
      <tr class="status-${entry.status}">
        <td class="id">#${entry.id}</td>
        <td class="time">${new Date(entry.timestamp).toLocaleString()}</td>
        <td class="cmd">
          <code>${escapeHtml(entry.command)}</code>
          <button class="copy-btn" onclick="copyCmd('${escapeJs(entry.command)}')">📋</button>
        </td>
        <td class="status"><span class="badge badge-${entry.status}">${entry.status}</span></td>
        <td class="reason">${escapeHtml(entry.reason)}</td>
      </tr>`
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kiro AutoRun History</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --badge-approved: #2ea04370;
      --badge-denied: #f8514970;
      --badge-manual: #848d9770;
    }
    body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 16px; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 12px 0; display: flex; align-items: center; gap: 8px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
    .toolbar button { 
      padding: 6px 14px; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground); border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar button.danger { background: #f8514930; border-color: #f85149; color: #f85149; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px; border-bottom: 2px solid var(--border); font-weight: 600; }
    td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .id { width: 50px; color: var(--vscode-descriptionForeground); }
    .time { width: 170px; white-space: nowrap; }
    .cmd { max-width: 400px; word-break: break-all; }
    .cmd code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; }
    .copy-btn { 
      background: none; border: none; cursor: pointer; font-size: 12px; padding: 2px 4px;
      opacity: 0.5; margin-left: 4px;
    }
    .copy-btn:hover { opacity: 1; }
    .status { width: 120px; }
    .badge { padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-auto-approved { background: var(--badge-approved); color: #3fb950; }
    .badge-denied { background: var(--badge-denied); color: #f85149; }
    .badge-manual { background: var(--badge-manual); color: #8b949e; }
    .empty { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
    .stats { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>⚡ Kiro AutoRun History</h1>
  <div class="stats">
    Total: ${entries.length} commands | 
    Auto-approved: ${entries.filter((e) => e.status === 'auto-approved').length} | 
    Denied: ${entries.filter((e) => e.status === 'denied').length} | 
    Manual: ${entries.filter((e) => e.status === 'manual').length}
  </div>
  <div class="toolbar">
    <button onclick="clearAll()" class="danger">🗑️ Clear History</button>
  </div>
  ${entries.length === 0
            ? '<div class="empty">No commands recorded yet. Commands will appear here as Kiro runs them.</div>'
            : `<table>
      <thead>
        <tr><th>#</th><th>Time</th><th>Command</th><th>Status</th><th>Reason</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
        }
  <script>
    const vscode = acquireVsCodeApi();
    function copyCmd(text) {
      vscode.postMessage({ command: 'copy', text: text });
    }
    function clearAll() {
      if (confirm('Clear all command history?')) {
        vscode.postMessage({ command: 'clear' });
      }
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
