import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { exec } from 'child_process';
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
let lastActionLogSize = 0;
let lastActionLogLines = 0;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Get the path to the bundled Python script
 */
function getPythonScriptPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'kiro-autorun-v3.py');
}

/**
 * Check if the current platform is macOS
 */
function isMacOS(): boolean {
    return process.platform === 'darwin';
}

/**
 * Start the Python backend via external Terminal.app.
 * Terminal.app already has Accessibility + Screen Recording permissions.
 */
function startBackend(context: vscode.ExtensionContext): void {
    if (isRunning) {
        return;
    }

    if (!isMacOS()) {
        outputChannel.appendLine('[WARN] macOS backend not available — Layer 1 (Settings API) still active');
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

    // Strategy: Open Terminal.app (has Screen Recording permission),
    // run script with nohup in background, exit shell to auto-close window,
    // then bring Kiro back to focus. Python keeps running with Terminal's permissions.
    const escaped = scriptPath.replace(/'/g, "'\"'\"'");
    const shellCmd = `defaults write org.python.python LSUIElement -bool true 2>/dev/null; nohup python3 '${escaped}' > /tmp/kiro-autorun.log 2>&1 & disown; sleep 0.3 && exit`;

    const script = `
tell application "Terminal"
  do script "${shellCmd.replace(/"/g, '\\"')}"
  -- Minimize the new window immediately to reduce flash
  try
    set miniaturized of front window to true
  end try
end tell
delay 0.5
tell application "System Events"
  set visible of process "Terminal" to false
end tell
tell application "${safeTargetApp}" to activate
`.trim();

    // FIX #2: Use random temp filename to prevent TOCTOU race condition
    const tmpScript = path.join('/tmp', `kiro-autorun-${crypto.randomBytes(8).toString('hex')}.scpt`);
    fs.writeFileSync(tmpScript, script, { encoding: 'utf-8', mode: 0o600 });

    exec(`osascript ${tmpScript}`, (err) => {
        // Clean up temp script immediately after execution
        try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }

        if (err) {
            outputChannel.appendLine(`Launch error: ${err.message}`);
            vscode.window.showErrorMessage(
                'AutoRun: Could not start. Make sure Terminal.app has Accessibility permission.',
                'Show Log'
            ).then((s) => { if (s) { outputChannel.show(); } });
            return;
        }
        isRunning = true;
        setStartTime();
        setBackendHealth(true);
        updateStatusBar(config, true);
        outputChannel.appendLine('Backend running in background. Log: /tmp/kiro-autorun.log');

        // Start polling the action log file
        startActionLogWatcher();
        startHealthCheck();
    });
}

/**
 * Stop the Python backend
 */
function stopBackend(): void {
    stopActionLogWatcher();
    stopHealthCheck();

    if (isRunning) {
        // Kill the python process — use -f (contains match, actual binary is Python not python3)
        exec('pkill -f kiro-autorun-v3.py', () => {
            outputChannel.appendLine('Backend stopped');
        });
        isRunning = false;
    }
    setBackendHealth(true); // Reset health state
    updateStatusBar(getConfig(), false);
}

/**
 * Start watching the action log file for new entries from Python backend
 */
function startActionLogWatcher(): void {
    stopActionLogWatcher();

    // Poll every 2 seconds for new action log entries
    actionLogWatcher = setInterval(() => {
        pollActionLog();
    }, 2000);
}

/**
 * Stop watching the action log file
 */
function stopActionLogWatcher(): void {
    if (actionLogWatcher) {
        clearInterval(actionLogWatcher);
        actionLogWatcher = undefined;
    }
}

const BACKEND_LOG = '/tmp/kiro-autorun.log';
const HEALTH_TIMEOUT_MS = 60_000; // 60s without log update = backend lost

/**
 * Start backend health monitoring
 */
function startHealthCheck(): void {
    stopHealthCheck();
    healthCheckInterval = setInterval(() => {
        if (!isRunning) { return; }
        try {
            if (fs.existsSync(BACKEND_LOG)) {
                const stat = fs.statSync(BACKEND_LOG);
                const age = Date.now() - stat.mtimeMs;
                const wasHealthy = isBackendHealthy();
                if (age > HEALTH_TIMEOUT_MS) {
                    setBackendHealth(false);
                    if (wasHealthy) {
                        // Only show warning once on transition
                        outputChannel.appendLine(`[WARN] Backend log stale for ${Math.round(age / 1000)}s — backend may have crashed`);
                        vscode.window.showWarningMessage(
                            'AutoRun backend lost — log not updated for 60s. Try restarting.',
                            'Restart', 'View Log'
                        ).then(choice => {
                            if (choice === 'View Log') { outputChannel.show(); }
                            if (choice === 'Restart') { vscode.commands.executeCommand('kiroAutorun.toggle'); }
                        });
                    }
                } else {
                    setBackendHealth(true);
                }
                updateStatusBar(getConfig(), isRunning);
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

                // Auto-learn: if Python detected a safe pattern, add to Kiro trustedCommands
                if (entry.learn && status === 'auto-approved') {
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
 * Auto-learn: add a new trusted pattern to Kiro's settings.
 * Called when Python backend identifies a safe command not yet in trusted list.
 * 
 * FIX #5 + #6: Validates pattern to prevent log injection attacks
 * and mirrors Python's NEVER_LEARN safety check.
 */
async function learnTrustedPattern(pattern: string): Promise<void> {
    // === FIX #5: Reject obviously malicious patterns ===
    if (!pattern || pattern.length > 50) { return; }          // Too long = suspicious
    if (pattern === '*') { return; }                           // Never trust ALL
    if (!pattern.includes(' ')) { return; }                    // Must be "command *" format
    if (/[;&|`$]/.test(pattern)) { return; }                   // No chain operators

    // === FIX #6: Mirror Python's NEVER_LEARN set ===
    const NEVER_LEARN = new Set([
        'rm', 'rmdir', 'chmod', 'chown', 'chgrp',
        'curl', 'wget', 'git', 'kill', 'pkill',
        'dd', 'mkfs', 'fdisk', 'sudo',
        'ssh', 'scp', 'rsync',
        'docker', 'kubectl',
        'pip', 'pip3', 'npm', 'npx',
        'eval', 'exec', 'source',
    ]);
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
                // FIX #6: Validate — same rules as learnTrustedPattern
                if (p === '*') {
                    vscode.window.showErrorMessage('Cannot trust "*" — use Full Autonomy command instead.');
                    return;
                }
                if (/[;&|`$]/.test(p)) {
                    vscode.window.showErrorMessage('Pattern contains dangerous characters.');
                    return;
                }
                const NEVER_TRUST = new Set(['rm', 'chmod', 'chown', 'curl', 'wget', 'git', 'kill', 'dd', 'mkfs', 'sudo', 'ssh', 'docker', 'kubectl', 'npm', 'npx', 'pip', 'eval', 'exec']);
                const baseCmd = p.split(' ')[0].toLowerCase();
                if (NEVER_TRUST.has(baseCmd)) {
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
