import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, spawn } from 'child_process';
import { getConfig, setConfigValue, writeConfigFile, onConfigChange, ACTION_LOG_FILE } from './config';
import {
    createStatusBar, updateStatusBar, disposeStatusBar,
    resetCounts, incrementApproved, incrementBlocked,
    setStartTime, setBackendHealth, isBackendHealthy,
} from './statusBar';
import { loadLog, addEntry, showLogPanel, clearLog } from './commandLog';
import { applyKiroSettings, setFullAutonomy, addTrustedPattern } from './kiroSettings';

let outputChannel: vscode.OutputChannel;
let isRunning = false;
let actionLogWatcher: ReturnType<typeof setInterval> | undefined;
let actionLogFsWatcher: fs.FSWatcher | undefined;
let lastActionLogSize = 0;
let lastActionLogLines = 0;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

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
 * Start the Python backend via external Terminal.app.
 * Terminal.app already has Accessibility + Screen Recording permissions.
 */
function startBackend(context: vscode.ExtensionContext): void {
    if (isRunning) {
        return;
    }

    if (!isMacOS() && !isWindows()) {
        outputChannel.appendLine('[WARN] Backend not available on this platform — Layer 1 (Settings API) still active');
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

    let child: ReturnType<typeof spawn>;

    if (isWindows()) {
        // Windows: spawn pythonw (no console window) or python
        const logFile = path.join(os.homedir(), '.kiro-autorun', 'backend.log');
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFd = fs.openSync(logFile, 'a');
        try {
            child = spawn('pythonw', [scriptPath], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
                env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                windowsHide: true,
            });
        } catch {
            // pythonw not found, try python
            try {
                child = spawn('python', [scriptPath], {
                    detached: true,
                    stdio: ['ignore', logFd, logFd],
                    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                    windowsHide: true,
                });
            } finally {
                // handled below
            }
        } finally {
            fs.closeSync(logFd);
        }
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
        } finally {
            fs.closeSync(logFd);
        }
    }

    child.unref(); // Allow Kiro to exit without waiting for Python

    if (child.pid) {
        isRunning = true;
        setStartTime();
        setBackendHealth(true);
        updateStatusBar(config, true);
        outputChannel.appendLine(`Backend running (PID: ${child.pid}). Log: ${getBackendLogPath()}`);
        startActionLogWatcher();
        startHealthCheck(context);
    } else {
        outputChannel.appendLine('[ERROR] Failed to spawn Python backend');
        vscode.window.showErrorMessage(
            'AutoRun: Could not start backend. Check Python3 is installed.',
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

    if (isRunning) {
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
        isRunning = false;
    }
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

const HEALTH_TIMEOUT_MS = 300_000; // 300s (5 min) without log update = backend lost
                                    // Python only logs when Kiro shows a prompt, so 60s was far too short

/**
 * Start backend health monitoring
 */
function startHealthCheck(context: vscode.ExtensionContext): void {
    stopHealthCheck();
    healthCheckInterval = setInterval(() => {
        if (!isRunning) { return; }
        const backendLog = getBackendLogPath();
        try {
            if (fs.existsSync(backendLog)) {
                const stat = fs.statSync(backendLog);
                const age = Date.now() - stat.mtimeMs;
                const wasHealthy = isBackendHealthy();
                if (age > HEALTH_TIMEOUT_MS) {
                    // Log is stale — verify the Python process is actually dead
                    const scriptName = isWindows() ? 'kiro-autorun-win' : 'kiro-autorun-v3.py';
                    const checkCmd = isWindows()
                        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${scriptName}*' } | Select-Object -ExpandProperty ProcessId"`
                        : `pgrep -f ${scriptName}`;

                    exec(checkCmd, (err, stdout) => {
                        const output = stdout?.trim() || '';
                        const processAlive = isWindows()
                            ? output.split('\n').filter(l => /^\d+/.test(l.trim())).length > 0
                            : !err && output.length > 0;

                        if (processAlive) {
                            setBackendHealth(true);
                        } else {
                            setBackendHealth(false);
                            if (wasHealthy) {
                                outputChannel.appendLine(`[WARN] Backend process died (log stale ${Math.round(age / 1000)}s) — auto-restarting...`);
                            }
                            isRunning = false;
                            startBackend(context);
                        }
                        updateStatusBar(getConfig(), isRunning);
                    });
                } else {
                    setBackendHealth(true);
                    updateStatusBar(getConfig(), isRunning);
                }
            }
        } catch {
            // ignore
        }
    }, 30_000); // Check every 30s
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
export function activate(context: vscode.ExtensionContext): void {
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

    // Restart backend (stop + start)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.restart', () => {
            outputChannel.appendLine('Restarting backend...');
            stopBackend();
            resetCounts();
            // Small delay to ensure process is killed before restart
            setTimeout(() => {
                const cfg = getConfig();
                if (cfg.enabled) {
                    startBackend(context);
                    vscode.window.showInformationMessage('AutoRun backend restarted');
                } else {
                    vscode.window.showInformationMessage('AutoRun is disabled. Enable it first.');
                }
            }, 500);
        })
    );

    // Reload window (full VS Code reload)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.reloadWindow', () => {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    // Config change listener
    context.subscriptions.push(
        onConfigChange((newConfig) => {
            writeConfigFile(newConfig);
            updateStatusBar(newConfig, isRunning);
        })
    );

    // Auto-start Layer 2 (backend) if enabled and on macOS
    if (config.enabled) {
        startBackend(context);
    }

    // Auto-restart detection: if this is a fresh install/update, prompt reload
    const installedVersionKey = 'kiroAutorun.lastInstalledVersion';
    const currentVersion = context.extension.packageJSON.version;
    const lastVersion = context.globalState.get<string>(installedVersionKey);
    if (lastVersion && lastVersion !== currentVersion) {
        outputChannel.appendLine(`Updated from v${lastVersion} to v${currentVersion}`);
        vscode.window.showInformationMessage(
            `Kiro AutoRun updated to v${currentVersion}. Reload to apply.`,
            'Reload Now'
        ).then(choice => {
            if (choice === 'Reload Now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
    context.globalState.update(installedVersionKey, currentVersion);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    stopBackend();
    cleanupTempFiles();
    disposeStatusBar();
}
