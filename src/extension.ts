import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, spawn } from 'child_process';
import { getConfig, setConfigValue, writeConfigFile, onConfigChange, ACTION_LOG_FILE, CONFIG_DIR } from './config';
import {
    createStatusBar, updateStatusBar, disposeStatusBar,
    resetCounts, incrementApproved, incrementBlocked,
    setStartTime, setBackendHealth, isBackendHealthy,
    setLastHeartbeat, getLastHeartbeat, setBackendPid,
} from './statusBar';
import { loadLog, addEntry, showLogPanel, clearLog } from './commandLog';
import { applyKiroSettings, setFullAutonomy, addTrustedPattern } from './kiroSettings';

let outputChannel: vscode.OutputChannel;
let isRunning = false;
let isBackendOwner = false;  // true if THIS window spawned the backend
let actionLogWatcher: ReturnType<typeof setInterval> | undefined;
let actionLogFsWatcher: fs.FSWatcher | undefined;
let lastActionLogSize = 0;
let lastActionLogLines = 0;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatPollInterval: ReturnType<typeof setInterval> | undefined;

const PID_FILE = path.join(CONFIG_DIR, 'backend.pid');
const HEARTBEAT_FILE = path.join(CONFIG_DIR, 'heartbeat');

let restartAttempts: { time: number }[] = [];  // Track restart attempts for backoff
const MAX_RESTARTS_IN_WINDOW = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the path to the bundled Python script for the current platform
 */
function getPythonScriptPath(context: vscode.ExtensionContext): string {
    if (isWindows()) {
        return path.join(context.extensionPath, 'kiro-autorun-win.py');
    }
    return path.join(context.extensionPath, 'kiro-autorun-v3.py');
}

/**
 * Check if the current platform is macOS
 */
function isMacOS(): boolean {
    return process.platform === 'darwin';
}

/**
 * Check if the current platform is Windows
 */
function isWindows(): boolean {
    return process.platform === 'win32';
}

/**
 * Check if a Python backend process is already running.
 * Uses PowerShell/pgrep to search by script name — more reliable than PID file on Windows.
 * Returns a Promise that resolves to the PID (number) if found, or null otherwise.
 */
function checkBackendProcessAlive(): Promise<number | null> {
    return new Promise((resolve) => {
        if (isWindows()) {
            const checkCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -like '*kiro-autorun-win*' } | Select-Object -First 1 -ExpandProperty ProcessId"`;
            exec(checkCmd, (err, stdout) => {
                const output = stdout?.trim() || '';
                const match = output.split('\n').find(l => /^\d+/.test(l.trim()));
                if (match) {
                    const pid = parseInt(match.trim(), 10);
                    outputChannel?.appendLine(`   Backend process found (PID: ${pid})`);
                    resolve(pid);
                } else {
                    resolve(null);
                }
            });
        } else {
            exec('pgrep -f kiro-autorun-v3.py', (err, stdout) => {
                const output = stdout?.trim() || '';
                if (!err && output.length > 0) {
                    const pid = parseInt(output.split('\n')[0].trim(), 10);
                    resolve(isNaN(pid) ? 1 : pid); // fallback to 1 if NaN but process exists
                } else {
                    resolve(null);
                }
            });
        }
    });
}

/**
 * Write PID file for the backend process.
 */
function writePidFile(pid: number): void {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(PID_FILE, pid.toString(), 'utf-8');
    } catch {
        // ignore
    }
}

/**
 * Remove PID file.
 */
function removePidFile(): void {
    try {
        if (fs.existsSync(PID_FILE)) {
            fs.unlinkSync(PID_FILE);
        }
    } catch {
        // ignore
    }
}

/**
 * Start the Python backend.
 * Uses process-name check to ensure only one backend runs across all windows.
 */
async function startBackend(context: vscode.ExtensionContext): Promise<void> {
    if (isRunning) {
        return;
    }

    if (!isMacOS() && !isWindows()) {
        outputChannel.appendLine('[WARN] Backend not available on this platform — Layer 1 (Settings API) still active');
        return;
    }

    // Check if a backend is already running (from another window)
    const existingPid = await checkBackendProcessAlive();
    if (existingPid !== null) {
        outputChannel.appendLine('Backend already running — attaching as observer');
        isRunning = true;
        isBackendOwner = false;
        
        setBackendPid(existingPid);
        
        setStartTime();
        setBackendHealth(true);
        updateStatusBar(getConfig(), true);
        startActionLogWatcher();
        startHealthCheck(context);
        startHeartbeatPoll();
        return;
    }

    const scriptPath = getPythonScriptPath(context);
    const config = getConfig();

    // FIX #1: Sanitize targetApp to prevent AppleScript injection
    const safeTargetApp = config.targetApp.replace(/[^a-zA-Z0-9 .\-]/g, '');
    if (safeTargetApp !== config.targetApp) {
        outputChannel.appendLine(`[WARN] SECURITY: targetApp sanitized: "${config.targetApp}" -> "${safeTargetApp}"`);
    }

    // Write config for Python to read
    writeConfigFile(config);

    // Preserve action log across restarts — count existing lines
    try {
        if (fs.existsSync(ACTION_LOG_FILE)) {
            const data = fs.readFileSync(ACTION_LOG_FILE, 'utf-8');
            const lines = data.trim().split('\n').filter(l => l.trim());
            lastActionLogLines = lines.length;
            lastActionLogSize = fs.statSync(ACTION_LOG_FILE).size;
        } else {
            lastActionLogSize = 0;
            lastActionLogLines = 0;
        }
    } catch {
        lastActionLogSize = 0;
        lastActionLogLines = 0;
    }

    outputChannel.appendLine('Launching AutoRun backend...');
    outputChannel.appendLine(`   Script: ${scriptPath}`);

    // Check restart backoff — prevent rapid restart loops
    const now = Date.now();
    restartAttempts = restartAttempts.filter(a => now - a.time < RESTART_WINDOW_MS);
    if (restartAttempts.length >= MAX_RESTARTS_IN_WINDOW) {
        outputChannel.appendLine(`[ERROR] Backend restarted ${restartAttempts.length} times in 5 min — stopping auto-restart`);
        vscode.window.showErrorMessage(
            `AutoRun: Backend keeps crashing (${restartAttempts.length} restarts in 5 min). Check Python backend log.`,
            'Show Log', 'Restart Anyway'
        ).then((choice) => {
            if (choice === 'Show Log') { outputChannel.show(); }
            if (choice === 'Restart Anyway') {
                restartAttempts = [];
                startBackend(context);
            }
        });
        return;
    }
    restartAttempts.push({ time: now });

    let child: ReturnType<typeof spawn> | undefined;

    if (isWindows()) {
        // Windows: spawn pythonw (no console window) or python
        const logFile = path.join(os.homedir(), '.kiro-autorun', 'backend.log');
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFd = fs.openSync(logFile, 'a');
        outputChannel.appendLine('   Trying pythonw...');
        try {
            child = spawn('pythonw', [scriptPath], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
                env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                windowsHide: true,
            });
            outputChannel.appendLine(`   pythonw spawned (PID: ${child?.pid || 'none'})`);
        } catch (e1) {
            outputChannel.appendLine(`   pythonw failed: ${e1}`);
            // pythonw not found, try python
            outputChannel.appendLine('   Trying python...');
            try {
                child = spawn('python', [scriptPath], {
                    detached: true,
                    stdio: ['ignore', logFd, logFd],
                    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                    windowsHide: true,
                });
                outputChannel.appendLine(`   python spawned (PID: ${child?.pid || 'none'})`);
            } catch (e2) {
                outputChannel.appendLine(`[ERROR] Both pythonw and python failed: ${e2}`);
            }
        }
        // Close fd after spawn — detached child already inherited a copy
        try { fs.closeSync(logFd); } catch { /* ignore */ }
    } else {
        // macOS: Set LSUIElement to hide Python Dock icon
        exec('defaults write org.python.python LSUIElement -bool true 2>/dev/null');

        const logFd = fs.openSync('/tmp/kiro-autorun.log', 'a');
        try {
            child = spawn('python3', [scriptPath], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
                env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            });
        } catch (e3) {
            outputChannel.appendLine(`[ERROR] python3 spawn failed: ${e3}`);
        }
        // Close fd after spawn — detached child already inherited a copy
        try { fs.closeSync(logFd); } catch { /* ignore */ }
    }

    if (!child) {
        outputChannel.appendLine('[ERROR] Failed to spawn Python backend — no python executable found');
        vscode.window.showErrorMessage(
            'AutoRun: Could not start backend. Install Python3 (python/pythonw must be in PATH).',
            'Show Log'
        ).then((s) => { if (s) { outputChannel.show(); } });
        return;
    }

    // Listen for spawn errors (e.g., ENOENT, permission denied)
    child.on('error', (err) => {
        outputChannel.appendLine(`[ERROR] Backend process error: ${err.message}`);
        isRunning = false;
        setBackendHealth(false);
        updateStatusBar(getConfig(), false);
    });

    // Listen for unexpected early exit (crash on startup)
    const spawnedPid = child.pid;
    child.on('exit', (code, signal) => {
        outputChannel.appendLine(`[WARN] Backend exited (code: ${code}, signal: ${signal}, PID: ${spawnedPid})`);
        isRunning = false;
        isBackendOwner = false;
        setBackendPid(null);
        setBackendHealth(false);
        updateStatusBar(getConfig(), false);
    });

    child.unref(); // Allow Kiro to exit without waiting for Python

    if (child.pid) {
        isRunning = true;
        isBackendOwner = true;
        writePidFile(child.pid);
        setBackendPid(child.pid);
        setStartTime();
        setBackendHealth(true);
        updateStatusBar(config, true);
        outputChannel.appendLine(`Backend running (PID: ${child.pid}). Log: ${getBackendLogPath()}`);
        startActionLogWatcher();
        startHealthCheck(context);
        startHeartbeatPoll();

        // Post-spawn verification: check process is still alive after 5 seconds
        // (catches immediate crashes that child.on('exit') might miss due to detach)
        setTimeout(() => {
            checkBackendProcessAlive().then((alive) => {
                if (!alive && isRunning) {
                    outputChannel.appendLine('[ERROR] Backend died within 5s of spawn — check backend.log for errors');
                    isRunning = false;
                    isBackendOwner = false;
                    setBackendPid(null);
                    setBackendHealth(false);
                    updateStatusBar(getConfig(), false);
                    vscode.window.showErrorMessage(
                        'AutoRun: Backend crashed on startup. Check Output log for details.',
                        'Show Log'
                    ).then((s) => { if (s) { outputChannel.show(); } });
                } else if (alive) {
                    outputChannel.appendLine(`Backend confirmed alive after 5s (PID: ${child?.pid})`);
                }
            });
        }, 5000);
    } else {
        outputChannel.appendLine('[ERROR] spawn returned no PID — backend may not be running');
        vscode.window.showErrorMessage(
            'AutoRun: Backend started but no PID returned. Check Python3 installation.',
            'Show Log'
        ).then((s) => { if (s) { outputChannel.show(); } });
    }
}

/**
 * Stop the Python backend
 */
function stopBackend(): void {
    stopActionLogWatcher();
    stopHealthCheck();
    stopHeartbeatPoll();

    if (isRunning) {
        // Only kill the backend if THIS window owns it
        if (isBackendOwner) {
            if (isWindows()) {
                // Windows: kill python process by script name using PowerShell
                exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*kiro-autorun-win*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', () => {
                    outputChannel.appendLine('Backend stopped');
                });
            } else {
                // macOS: Kill the python process
                exec('pkill -f kiro-autorun-v3.py', () => {
                    outputChannel.appendLine('Backend stopped');
                });
            }
            removePidFile();
        } else {
            outputChannel.appendLine('Detached from backend (owned by another window)');
        }
        isRunning = false;
        isBackendOwner = false;
    }
    setBackendPid(null);
    setBackendHealth(false); // Mark as not healthy when stopped
    updateStatusBar(getConfig(), false);
}

/**
 * Start watching the action log file for new entries from Python backend.
 * Primary: fs.watch (instant notification on file change, 0s delay).
 * Fallback: setInterval every 10s (safety net if fs.watch unavailable).
 */
function startActionLogWatcher(): void {
    stopActionLogWatcher();

    const watchTarget = ACTION_LOG_FILE;

    // Primary: fs.watch — notified immediately when Python writes a new entry
    try {
        // Ensure file exists so fs.watch has something to watch
        if (!fs.existsSync(watchTarget)) {
            const dir = path.dirname(watchTarget);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(watchTarget, '', 'utf-8');
        }
        actionLogFsWatcher = fs.watch(watchTarget, () => {
            pollActionLog();
        });
        actionLogFsWatcher.on('error', () => {
            // fs.watch failed — fall through to setInterval fallback
        });
    } catch {
        // fs.watch may not be available (network drives etc.)
    }

    // Fallback: slow poll every 10s as a safety net
    actionLogWatcher = setInterval(() => {
        pollActionLog();
    }, 10_000);
}

/**
 * Stop watching the action log file
 */
function stopActionLogWatcher(): void {
    if (actionLogFsWatcher) {
        actionLogFsWatcher.close();
        actionLogFsWatcher = undefined;
    }
    if (actionLogWatcher) {
        clearInterval(actionLogWatcher);
        actionLogWatcher = undefined;
    }
}

/**
 * Get the backend log file path (platform-aware)
 */
function getBackendLogPath(): string {
    if (isWindows()) {
        return path.join(os.homedir(), '.kiro-autorun', 'backend.log');
    }
    return '/tmp/kiro-autorun.log';
}

const HEALTH_TIMEOUT_MS = 120_000; // 120s (2 min) without heartbeat = backend lost
                                    // Heartbeat writes every cycle (~1-3s), so 2 min is very generous

/**
 * Start backend health monitoring.
 * Reads heartbeat file (written every cycle by Python) for accurate alive detection.
 * Falls back to backend.log mtime if heartbeat file not found (old Python version).
 */
function startHealthCheck(context: vscode.ExtensionContext): void {
    stopHealthCheck();
    healthCheckInterval = setInterval(() => {
        if (!isRunning) { return; }

        try {
            // Primary: check heartbeat file (Python writes timestamp every cycle)
            let lastAliveMs = 0;
            if (fs.existsSync(HEARTBEAT_FILE)) {
                const content = fs.readFileSync(HEARTBEAT_FILE, 'utf-8').trim();
                const ts = parseFloat(content);
                if (!isNaN(ts)) {
                    lastAliveMs = ts * 1000; // Python time.time() is in seconds
                }
            }

            // Fallback: backend.log mtime (for older Python versions without heartbeat)
            if (lastAliveMs === 0) {
                const backendLog = getBackendLogPath();
                if (fs.existsSync(backendLog)) {
                    lastAliveMs = fs.statSync(backendLog).mtimeMs;
                }
            }

            if (lastAliveMs === 0) { return; } // No data yet

            const age = Date.now() - lastAliveMs;
            const wasHealthy = isBackendHealthy();

            if (age > HEALTH_TIMEOUT_MS) {
                // Heartbeat is stale — verify the Python process is actually dead
                checkBackendProcessAlive().then((processAlive) => {
                    if (processAlive) {
                        setBackendHealth(true);
                    } else {
                        setBackendHealth(false);
                        isRunning = false;
                        isBackendOwner = false;

                        if (wasHealthy) {
                            outputChannel.appendLine(`[WARN] Backend process died (heartbeat stale ${Math.round(age / 1000)}s) — auto-restarting...`);
                        }
                        // Re-run startBackend — it will check restart backoff
                        startBackend(context);
                    }
                    updateStatusBar(getConfig(), isRunning);
                });
            } else {
                setBackendHealth(true);
                updateStatusBar(getConfig(), isRunning);
            }
        } catch {
            // ignore
        }
    }, 30_000); // Check every 30s
}

/**
 * Read heartbeat timestamp from file.
 * Returns timestamp in ms, or 0 if unavailable.
 */
function readHeartbeat(): number {
    try {
        if (fs.existsSync(HEARTBEAT_FILE)) {
            const content = fs.readFileSync(HEARTBEAT_FILE, 'utf-8').trim();
            const ts = parseFloat(content);
            if (!isNaN(ts)) {
                return ts * 1000; // Python time.time() is in seconds
            }
        }
    } catch { /* ignore */ }
    return 0;
}

/**
 * Start polling heartbeat file every 10s to update status bar in real-time.
 * This is separate from health check (30s) — purpose is UI freshness.
 */
function startHeartbeatPoll(): void {
    stopHeartbeatPoll();
    // Read immediately
    const hb = readHeartbeat();
    if (hb > 0) { setLastHeartbeat(hb); }
    updateStatusBar(getConfig(), isRunning);

    heartbeatPollInterval = setInterval(() => {
        if (!isRunning) { return; }
        const hb = readHeartbeat();
        if (hb > 0) { setLastHeartbeat(hb); }
        updateStatusBar(getConfig(), isRunning);
    }, 10_000); // Every 10s
}

/**
 * Stop heartbeat polling
 */
function stopHeartbeatPoll(): void {
    if (heartbeatPollInterval) {
        clearInterval(heartbeatPollInterval);
        heartbeatPollInterval = undefined;
    }
}

/**
 * Stop backend health monitoring
 */
function stopHealthCheck(): void {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = undefined;
    }
}

/**
 * Poll the action log file for new entries (JSON-lines format)
 */
function pollActionLog(): void {
    if (!fs.existsSync(ACTION_LOG_FILE)) {
        return;
    }

    try {
        const stat = fs.statSync(ACTION_LOG_FILE);
        if (stat.size <= lastActionLogSize) {
            return;
        }
        lastActionLogSize = stat.size;

        const data = fs.readFileSync(ACTION_LOG_FILE, 'utf-8');
        const lines = data.trim().split('\n');

        // Process only lines we haven't seen before
        const startIdx = lastActionLogLines;
        lastActionLogLines = lines.length;

        for (let i = startIdx; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) { continue; }

            try {
                const entry = JSON.parse(line);
                const status = entry.type === 'auto-approved' ? 'auto-approved' : 'denied';

                // Forward stuck detection as VS Code warning
                if (entry.type === 'stuck') {
                    outputChannel.appendLine(`[STUCK] ${entry.reason}`);
                    vscode.window.showWarningMessage(
                        `AutoRun stuck: ${entry.reason}`,
                        'View Log'
                    ).then(choice => {
                        if (choice === 'View Log') { outputChannel.show(); }
                    });
                    continue;
                }

                addEntry(entry.command || 'unknown', entry.reason || '', status);

                if (status === 'auto-approved') {
                    incrementApproved();
                } else {
                    incrementBlocked();
                }

                updateStatusBar(getConfig(), isRunning);
                outputChannel.appendLine(`${status === 'auto-approved' ? '[OK]' : '[BLOCKED]'} ${entry.command} — ${entry.reason}`);

                // Auto-learn: if Python signals a safe pattern, add to Kiro trustedCommands
                if (entry.learn && status === 'auto-approved') {
                    learnTrustedPattern(entry.learn);
                }
                // Auto-trust: frequency threshold reached — add immediately without waiting
                if (entry.auto_trust && entry.learn && status === 'auto-approved') {
                    outputChannel.appendLine(`[LEARN] Auto-trust threshold reached for "${entry.learn}" — adding to Kiro trustedCommands`);
                    learnTrustedPattern(entry.learn);
                }
            } catch {
                // Skip malformed lines
            }
        }
    } catch {
        // File may be in the process of being written
    }
}

/**
 * Commands that should never be auto-learned as trusted patterns.
 * Mirrors Python backend's NEVER_LEARN set — keep in sync.
 */
const NEVER_LEARN = new Set([
    'rm', 'rmdir', 'chmod', 'chown', 'chgrp',
    'curl', 'wget', 'git', 'kill', 'pkill',
    'dd', 'mkfs', 'fdisk', 'sudo',
    'ssh', 'scp', 'rsync',
    'docker', 'kubectl',
    'pip', 'pip3', 'npm', 'npx',
    'eval', 'exec', 'source', '.', // '.' is shell source alias
]);

/**
 * Auto-learn: add a new trusted pattern to Kiro's settings.
 * Called when Python backend identifies a safe command not yet in trusted list.
 * Validates pattern to prevent log injection attacks and mirrors Python's NEVER_LEARN.
 */
async function learnTrustedPattern(pattern: string): Promise<void> {
    // Reject obviously malicious patterns
    if (!pattern || pattern.length > 50) { return; }          // Too long = suspicious
    if (pattern === '*') { return; }                           // Never trust ALL
    if (!pattern.includes(' ')) { return; }                    // Must be "command *" format
    if (/[;&|`$]/.test(pattern)) { return; }                   // No chain operators

    // Mirror Python's NEVER_LEARN set
    const baseCmd = pattern.split(' ')[0].toLowerCase();
    if (NEVER_LEARN.has(baseCmd)) {
        outputChannel.appendLine(`Refused to learn "${pattern}" — base command "${baseCmd}" is in NEVER_LEARN`);
        return;
    }

    try {
        const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');
        const current = kiroConfig.get<string[]>('trustedCommands', []);
        if (!current.includes(pattern)) {
            current.push(pattern);
            await kiroConfig.update('trustedCommands', current, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine(`Learned: "${pattern}" -> added to Kiro trustedCommands`);
        }
    } catch {
        // Kiro config may not exist
    }
}

/**
 * Clean up temp files
 */
function cleanupTempFiles(): void {
    const tempFiles = [
        '/tmp/kiro-autorun-launch.scpt',
    ];
    for (const file of tempFiles) {
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch {
            // ignore
        }
    }
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('Kiro AutoRun');
    context.subscriptions.push(outputChannel);

    loadLog();

    const statusBar = createStatusBar();
    context.subscriptions.push(statusBar);

    const config = getConfig();
    writeConfigFile(config);
    updateStatusBar(config, false);

    // === LAYER 1: Apply Kiro's own settings (cross-platform, primary mechanism) ===
    applyKiroSettings(outputChannel);

    // Toggle command
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.toggle', async () => {
            const cfg = getConfig();
            const newEnabled = !cfg.enabled;
            await setConfigValue('enabled', newEnabled);

            if (newEnabled) {
                startBackend(context);
            } else {
                stopBackend();
            }
        })
    );

    // Full autonomy toggle (trust ALL commands)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.fullAutonomy', async () => {
            const choice = await vscode.window.showWarningMessage(
                '[WARN] Full Autonomy trusts ALL commands. Are you sure?',
                'Enable Full Autonomy', 'Restore Safe Patterns'
            );
            if (choice === 'Enable Full Autonomy') {
                // FIX #9: Require typing CONFIRM to prevent accidental activation
                const confirm = await vscode.window.showInputBox({
                    prompt: 'Type CONFIRM to enable Full Autonomy (trusts ALL commands)',
                    placeHolder: 'CONFIRM',
                });
                if (confirm === 'CONFIRM') {
                    await setFullAutonomy(true, outputChannel);
                } else {
                    vscode.window.showInformationMessage('Full Autonomy cancelled.');
                }
            } else if (choice === 'Restore Safe Patterns') {
                await setFullAutonomy(false, outputChannel);
            }
        })
    );

    // Add trusted pattern
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.addTrusted', async () => {
            const pattern = await vscode.window.showInputBox({
                prompt: 'Add trusted command pattern (e.g. "make *", "cargo *")',
                placeHolder: 'command *',
            });
            if (pattern?.trim()) {
                const p = pattern.trim();
                // Validate — same rules as learnTrustedPattern, using shared NEVER_LEARN
                if (p === '*') {
                    vscode.window.showErrorMessage('Cannot trust "*" — use Full Autonomy command instead.');
                    return;
                }
                if (/[;&|`$]/.test(p)) {
                    vscode.window.showErrorMessage('Pattern contains dangerous characters.');
                    return;
                }
                const baseCmd = p.split(' ')[0].toLowerCase();
                if (NEVER_LEARN.has(baseCmd)) {
                    vscode.window.showWarningMessage(`"${baseCmd}" has dangerous variants — cannot be trusted as wildcard. Add specific safe patterns instead.`);
                    return;
                }
                await addTrustedPattern(p, outputChannel);
            }
        })
    );

    // Show log
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.showLog', () => {
            showLogPanel(context);
        })
    );

    // Clear log
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.clearLog', () => {
            clearLog();
            resetCounts();
            updateStatusBar(getConfig(), isRunning);
        })
    );

    // Add banned keyword (syncs to both AutoRun and Kiro denylist)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.addBanned', async () => {
            const keyword = await vscode.window.showInputBox({
                prompt: 'Add a banned keyword (syncs to Kiro denylist + AutoRun)',
                placeHolder: 'rm -rf',
            });
            if (keyword?.trim()) {
                const cfg = getConfig();
                const newBanned = [...cfg.bannedKeywords, keyword.trim()];
                await setConfigValue('bannedKeywords', newBanned);
                // Also sync to Kiro's own denylist
                try {
                    const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');
                    const currentDenylist = kiroConfig.get<string[]>('commandDenylist', []);
                    if (!currentDenylist.includes(keyword.trim())) {
                        await kiroConfig.update(
                            'commandDenylist',
                            [...currentDenylist, keyword.trim()],
                            vscode.ConfigurationTarget.Global
                        );
                    }
                } catch { /* Kiro setting may not exist */ }
            }
        })
    );

    // Show output channel
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.showOutput', () => {
            outputChannel.show();
        })
    );

    // Restart backend (force-kill + start fresh)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.restart', () => {
            outputChannel.appendLine('Restarting backend (force-kill)...');

            // Always force-kill ALL backend processes, regardless of ownership
            stopActionLogWatcher();
            stopHealthCheck();
            stopHeartbeatPoll();

            if (isWindows()) {
                exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*kiro-autorun-win*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', () => {
                    outputChannel.appendLine('Old backend killed');
                });
            } else {
                exec('pkill -f kiro-autorun-v3.py', () => {
                    outputChannel.appendLine('Old backend killed');
                });
            }
            removePidFile();
            isRunning = false;
            isBackendOwner = false;
            setBackendPid(null);
            setBackendHealth(false);
            resetCounts();
            restartAttempts = []; // Reset backoff for explicit restart
            updateStatusBar(getConfig(), false);

            // Wait 1.5s for PowerShell kill to complete before spawning new
            setTimeout(() => {
                const cfg = getConfig();
                if (cfg.enabled) {
                    startBackend(context);
                    vscode.window.showInformationMessage('AutoRun backend restarted');
                } else {
                    vscode.window.showInformationMessage('AutoRun is disabled. Enable it first.');
                }
            }, 1500);
        })
    );

    // Reload window (full VS Code reload)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.reloadWindow', () => {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    // Check backend status
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.checkStatus', async () => {
            const processAlive = await checkBackendProcessAlive();
            const hb = readHeartbeat();
            const hbAge = hb > 0 ? Math.round((Date.now() - hb) / 1000) : -1;
            const logPath = getBackendLogPath();
            let logAge = -1;
            try {
                if (fs.existsSync(logPath)) {
                    logAge = Math.round((Date.now() - fs.statSync(logPath).mtimeMs) / 1000);
                }
            } catch { /* ignore */ }

            const lines = [
                `Backend Process: ${processAlive ? '✅ RUNNING' : '❌ NOT RUNNING'}`,
                `Extension State: ${isRunning ? 'Active' : 'Inactive'} (owner: ${isBackendOwner ? 'yes' : 'no'})`,
                `Heartbeat: ${hbAge >= 0 ? `${hbAge}s ago` : 'no heartbeat file'}`,
                `Log last modified: ${logAge >= 0 ? `${logAge}s ago` : 'no log file'}`,
                `Health: ${isBackendHealthy() ? '✓ Healthy' : '⚠ Unhealthy'}`,
            ];

            outputChannel.appendLine('\n── Backend Status Check ──');
            lines.forEach(l => outputChannel.appendLine(`  ${l}`));
            outputChannel.appendLine('──────────────────────────');
            outputChannel.show();

            if (!processAlive && isRunning) {
                const choice = await vscode.window.showWarningMessage(
                    'Backend process is NOT running!',
                    'Restart', 'Dismiss'
                );
                if (choice === 'Restart') {
                    stopBackend();
                    resetCounts();
                    setTimeout(() => startBackend(context), 500);
                }
            } else if (processAlive) {
                vscode.window.showInformationMessage(
                    `AutoRun backend is running (heartbeat: ${hbAge >= 0 ? hbAge + 's ago' : 'N/A'})`
                );
            } else {
                vscode.window.showInformationMessage('AutoRun is not running. Click status bar to enable.');
            }
        })
    );

    // Config change listener
    context.subscriptions.push(
        onConfigChange((newConfig) => {
            writeConfigFile(newConfig);
            updateStatusBar(newConfig, isRunning);
        })
    );

    // Force-restart backend on version change OR Python script change
    const currentVersion = context.extension.packageJSON.version;
    const versionFile = path.join(CONFIG_DIR, 'ext.version');
    const scriptHashFile = path.join(CONFIG_DIR, 'script.hash');
    let needsForceRestart = false;

    // Check 1: Version change
    try {
        if (fs.existsSync(versionFile)) {
            const savedVersion = fs.readFileSync(versionFile, 'utf-8').trim();
            if (savedVersion !== currentVersion) {
                needsForceRestart = true;
                outputChannel.appendLine(`Version changed: v${savedVersion} → v${currentVersion} — force-restarting backend`);
            }
        } else {
            needsForceRestart = true; // First install or missing version file
        }
    } catch { /* ignore */ }

    // Check 2: Python script content change (catches same-version reinstalls with code changes)
    try {
        const scriptPath = getPythonScriptPath(context);
        const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
        const currentHash = crypto.createHash('md5').update(scriptContent).digest('hex');
        if (fs.existsSync(scriptHashFile)) {
            const savedHash = fs.readFileSync(scriptHashFile, 'utf-8').trim();
            if (savedHash !== currentHash && !needsForceRestart) {
                needsForceRestart = true;
                outputChannel.appendLine(`Python script changed (hash ${savedHash.slice(0,8)}→${currentHash.slice(0,8)}) — force-restarting backend`);
            }
        }
        // Save current hash
        fs.writeFileSync(scriptHashFile, currentHash, 'utf-8');
    } catch { /* ignore */ }

    // Write current version
    try {
        if (!fs.existsSync(CONFIG_DIR)) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); }
        fs.writeFileSync(versionFile, currentVersion, 'utf-8');
    } catch { /* ignore */ }

    if (needsForceRestart) {
        outputChannel.appendLine('Force-killing ALL existing backend processes...');
        // Kill ALL existing Python backends (they may have old code)
        if (isWindows()) {
            exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*kiro-autorun-win*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"');
        } else {
            exec('pkill -f kiro-autorun-v3.py');
        }
        removePidFile();
        // Clean up stale heartbeat file so status bar starts fresh
        try { if (fs.existsSync(HEARTBEAT_FILE)) { fs.unlinkSync(HEARTBEAT_FILE); } } catch { /* ignore */ }
        // Wait for processes to die before starting fresh
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Auto-start Layer 2 (backend) if enabled
    if (config.enabled) {
        startBackend(context);
    } else {
        // Even if disabled, start heartbeat poll in case backend is running from another window
        startHeartbeatPoll();
    }

    context.globalState.update('kiroAutorun.lastInstalledVersion', currentVersion);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    stopBackend();
    cleanupTempFiles();
    disposeStatusBar();
}
