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
    setStartTime,
} from './statusBar';
import { loadLog, addEntry, showLogPanel, clearLog } from './commandLog';
import { applyKiroSettings, setFullAutonomy, addTrustedPattern } from './kiroSettings';

let outputChannel: vscode.OutputChannel;
let isRunning = false;
let isBackendOwner = false;  // true if THIS window spawned the backend
/**
 * Start the Native TypeScript backend.
 * Python OCR is permanently disabled!
 */
async function startBackend(context: vscode.ExtensionContext): Promise<void> {
    if (isRunning) {
        return;
    }

    isRunning = true;
    isBackendOwner = true;
    
    setStartTime();
    updateStatusBar(getConfig(), true);

    outputChannel.appendLine('✅ Native Layer 0 active exclusively — Python OCR backend completely disabled.');
    outputChannel.appendLine('   Cursor hijacking eliminated. Zero CPU overhead.');
}

/**
 * Stop backend.
 */
function stopBackend(): void {
    if (!isRunning) {
        return;
    }
    isRunning = false;
    isBackendOwner = false;
    updateStatusBar(getConfig(), false);
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

// ─── Layer 0: Native TypeScript Kiro Command Auto-Approver ─────────────────
// Uses kiroAgent's own VS Code command API — no OCR, no mouse, instant (<200ms)

let kiroCommandPollInterval: ReturnType<typeof setInterval> | undefined;
let lastNativeApproveTime = 0;
let lastNativeLogTime = 0;
const NATIVE_APPROVE_COOLDOWN = 1500; // ms between native approvals
const handledNativeOpIds = new Set<string>();
let lastPendingQuestionsStr = '';

const approvalFreq = new Map<string, number>();

function getLearnPattern(cmd: string): string | null {
    if (!cmd) return null;
    const parts = cmd.trim().split(/\s+/);
    let baseCmd = parts[0].toLowerCase();
    
    // remove .exe / .bat
    baseCmd = baseCmd.replace(/\.(exe|cmd|bat)$/, '');
    // remove path
    baseCmd = baseCmd.split(/[/\\]/).pop() || baseCmd;
    
    if (NEVER_LEARN.has(baseCmd)) return null;
    // Don't auto-learn super common explicit commands, only project specific tools
    // We can skip this check or just trust the frequency
    
    const hasPathArg = parts.slice(1).some(p => (p.includes('/') || p.includes('\\')) && !p.startsWith('-'));
    const isShort = parts.length <= 3;
    
    if (isShort && !hasPathArg) {
        return cmd.trim();
    }
    return `${baseCmd} *`;
}

/**
 * Try to approve any pending Kiro prompts using the kiroAgent command API.
 * Covers: background process run, accept all diffs, user response prompts.
 * Returns true if an approval action was taken.
 */
async function tryNativeApprove(): Promise<boolean> {
    const now = Date.now();
    if (now - lastNativeApproveTime < NATIVE_APPROVE_COOLDOWN) {
        return false;
    }

    let acted = false;

    // 1. Check internal execution state for pending commands or code diffs
    try {
        const state = await vscode.commands.executeCommand<any>('kiroAgent.executions.getExecutions');
        let ops: any[] = [];
        
        if (state?.activeExecution?.payload?.operations) {
            ops = state.activeExecution.payload.operations;
        } else if (Array.isArray(state)) {
            const active = state.find(s => s.status === 'Yielded' || s.status === 'Running' || s.status === 'Paused');
            ops = active?.payload?.operations || active?.operations || [];
        }

        const pendingOps = ops.filter(op => 
            (op.status === 'PendingAction' || op.status === 'Pending') && 
            op.id && 
            !handledNativeOpIds.has(op.id)
        );

        if (pendingOps.length > 0) {
            // Track them so we don't approve them again next poll
            for (const op of pendingOps) {
                handledNativeOpIds.add(op.id);
            }
            if (handledNativeOpIds.size > 500) {
                handledNativeOpIds.clear();
            }

            // Found something pending! Let's check what it is for safety.
            const cmdOp = pendingOps.find(op => op.type === 'Command' && op.command);
            const commandStr = cmdOp ? cmdOp.command : '';
            
            if (commandStr) {
                // Safety check against banned keywords
                const cfg = getConfig();
                const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');
                const denylist = kiroConfig.get<string[]>('commandDenylist', []);
                const trustedCommands = kiroConfig.get<string[]>('trustedCommands', []);
                
                const isBanned = denylist.some(banned => commandStr.includes(banned.trim()));
                if (isBanned && !trustedCommands.includes('*')) { // full autonomy bypasses ban
                    outputChannel.appendLine(`[Native] ❌ BLOCKED command: "${commandStr}" (contains banned keyword)`);
                    await vscode.commands.executeCommand('kiroAgent.execution.rejectAll');
                    incrementBlocked();
                    addEntry(commandStr, 'Trigger: Native-API [Blocked]', 'denied');
                    lastNativeApproveTime = Date.now();
                    return false; // we acted, but we denied it, so we don't count it as approved. But we should avoid looping.
                }

                // TS Native Auto-Learn
                const learnPattern = getLearnPattern(commandStr);
                if (learnPattern) {
                    const count = (approvalFreq.get(learnPattern) || 0) + 1;
                    approvalFreq.set(learnPattern, count);
                    
                    if (count >= 2 && !trustedCommands.includes(learnPattern) && !kiroConfig.get<string[]>('trustedCommands', []).includes(learnPattern)) {
                        learnTrustedPattern(learnPattern);
                    }
                }

                outputChannel.appendLine(`[Native] Auto-approving Command: "${commandStr}"`);
            } else {
                outputChannel.appendLine(`[Native] Auto-approving Code/Diff changes`);
            }

            // Safe to approve!
            await vscode.commands.executeCommand('kiroAgent.execution.runOrAcceptAll');
            lastNativeApproveTime = Date.now();
            acted = true;
        }
    } catch {
        // command not available
    }

    return acted;
}

/**
 * Start the native TypeScript auto-approver poller.
 * Polls every 300ms and invokes kiroAgent commands directly.
 */
function startKiroCommandPoller(): void {
    if (kiroCommandPollInterval) { return; }

    let consecutiveActed = 0;

    kiroCommandPollInterval = setInterval(async () => {
        const cfg = getConfig();
        if (!cfg.enabled) { return; }

        try {
            const acted = await tryNativeApprove();
            if (acted) {
                consecutiveActed++;
                if (consecutiveActed === 1) {
                    const now = Date.now();
                    if (now - lastNativeLogTime > 3000) {
                        lastNativeLogTime = now;
                        outputChannel.appendLine(`[Native] ✓ Auto-approved via kiroAgent command API`);
                        incrementApproved();
                        addEntry('kiro-native', 'Trigger: Native-API [TS]', 'auto-approved');
                        updateStatusBar(cfg, isRunning);
                    } else {
                        outputChannel.appendLine(`[Native] Suppressed duplicate log entry (grouped within 3s)`);
                    }
                }
            } else {
                consecutiveActed = 0;
            }
        } catch {
            // ignore errors in poller
        }
    }, 300);

    outputChannel.appendLine('[Native] Kiro command poller started (Layer 0 — 300ms)');
}

function stopKiroCommandPoller(): void {
    if (kiroCommandPollInterval) {
        clearInterval(kiroCommandPollInterval);
        kiroCommandPollInterval = undefined;
        outputChannel.appendLine('[Native] Kiro command poller stopped');
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

    // Export button metadata for backend (simple API)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.exportButtonMetadata', async () => {
            const dummyButtons = [
                { id: 'run', role: 'Run', rect: { x: 100, y: 200, width: 80, height: 30 } },
                { id: 'accept', role: 'Accept', rect: { x: 200, y: 200, width: 80, height: 30 } }
            ];
            const metadataPath = path.join(CONFIG_DIR, 'button_metadata.json');
            try {
                fs.writeFileSync(metadataPath, JSON.stringify(dummyButtons, null, 2), 'utf-8');
                outputChannel.appendLine(`[INFO] Button metadata written to ${metadataPath}`);
            } catch (e) {
                outputChannel.appendLine(`[ERROR] Failed to write button metadata: ${e}`);
            }
        })
    );

    // Show output channel
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.showOutput', () => {
            outputChannel.show();
        })
    );

    // Restart backend (re-init Layer 0)
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.restart', () => {
            outputChannel.appendLine('Restarting Native backend...');

            isRunning = false;
            isBackendOwner = false;
            resetCounts();
            updateStatusBar(getConfig(), false);

            setTimeout(() => {
                const cfg = getConfig();
                if (cfg.enabled) {
                    startBackend(context);
                    vscode.window.showInformationMessage('AutoRun Native backend restarted');
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

    // Dump all VS Code/Kiro commands to file for discovery
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.dumpCommands', async () => {
            try {
                const allCmds = await vscode.commands.getCommands(true);
                const keywords = ['accept', 'run', 'approve', 'agent', 'kiro', 'diff', 'inline', 'chat', 'confirm', 'trust', 'apply'];
                const filtered = allCmds.filter(cmd =>
                    keywords.some(kw => cmd.toLowerCase().includes(kw))
                ).sort();
                const outPath = path.join(CONFIG_DIR, 'kiro_commands.json');
                fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2), 'utf-8');
                outputChannel.appendLine(`[INFO] Dumped ${filtered.length} commands to ${outPath}`);
                vscode.window.showInformationMessage(`Dumped ${filtered.length} commands → ${outPath}`);
            } catch (e) {
                outputChannel.appendLine(`[ERROR] dumpCommands failed: ${e}`);
            }
        })
    );

    // Debug Kiro Internal State
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.debugState', async () => {
            try {
                const ex1 = await vscode.commands.executeCommand('kiroAgent.executions.getExecutions');
                const ex2 = await vscode.commands.executeCommand('kiroAgent.executions.getPendingQuestions');
                let ex3 = null;
                try { ex3 = await vscode.commands.executeCommand('kiroAgent.execution.getExecutionChanges'); } catch {}
                
                const outPath = path.join(CONFIG_DIR, 'kiro_state_debug.json');
                const debugData = {
                    getExecutions: ex1,
                    getPendingQuestions: ex2,
                    getExecutionChanges: ex3,
                    timestamp: new Date().toISOString()
                };
                fs.writeFileSync(outPath, JSON.stringify(debugData, null, 2), 'utf-8');
                outputChannel.appendLine(`[INFO] State dumped to ${outPath}`);
                vscode.window.showInformationMessage(`State dumped → ${outPath}`);
            } catch (e) {
                vscode.window.showErrorMessage(`Debug state failed: ${e}`);
                outputChannel.appendLine(`[ERROR] debugState failed: ${e}`);
            }
        })
    );

    // Check backend status
    context.subscriptions.push(
        vscode.commands.registerCommand('kiroAutorun.checkStatus', async () => {
            const lines = [
                `Native Backend Process: ${isRunning ? '✅ RUNNING' : '❌ NOT RUNNING'}`,
                `Extension State: ${isRunning ? 'Active' : 'Inactive'}`,
            ];

            outputChannel.appendLine('\n── Backend Status Check ──');
            lines.forEach(l => outputChannel.appendLine(`  ${l}`));
            outputChannel.appendLine('──────────────────────────');
            outputChannel.show();

            if (!isRunning) {
                vscode.window.showInformationMessage('AutoRun is not running. Click status bar to enable.');
            } else {
                vscode.window.showInformationMessage('AutoRun Native Backend is running healthy.');
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
    // Auto-start Layer 0
    if (config.enabled) {
        startBackend(context);
    }

    // Always start Layer 0 poller (it checks config.enabled internally)
    startKiroCommandPoller();

    context.globalState.update('kiroAutorun.lastInstalledVersion', currentVersion);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    stopBackend();
    stopKiroCommandPoller();
    disposeStatusBar();
}
