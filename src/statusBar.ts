import * as vscode from 'vscode';
import { AutoRunConfig } from './config';

let statusBarItem: vscode.StatusBarItem;
let approvedCount = 0;
let blockedCount = 0;

export function createStatusBar(): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'kiroAutorun.toggle';
    return statusBarItem;
}

export function updateStatusBar(config: AutoRunConfig, running: boolean): void {
    if (!statusBarItem) {
        return;
    }

    if (!config.enabled || !running) {
        statusBarItem.text = '$(circle-slash) AutoRun OFF';
        statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground'
        );
        statusBarItem.color = undefined;
        statusBarItem.tooltip = [
            '⚡ Kiro AutoRun',
            '━━━━━━━━━━━━━━━━━━',
            '⊘ Status: DISABLED',
            '',
            'Click to enable',
        ].join('\n');
    } else {
        const stats = approvedCount > 0 || blockedCount > 0
            ? ` ┊ ✓${approvedCount} ✕${blockedCount}`
            : '';
        statusBarItem.text = `$(zap) AutoRun ON${stats}`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.color = '#3fb950';
        statusBarItem.tooltip = [
            '⚡ Kiro AutoRun — Ops Monitor',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `✓ Approved: ${approvedCount}`,
            `✕ Blocked: ${blockedCount}`,
            `🛡 Banned keywords: ${config.bannedKeywords.length}`,
            `⏱ Poll interval: ${config.pollInterval}s`,
            '',
            'Click to disable',
        ].join('\n');
    }

    statusBarItem.show();
}

export function incrementApproved(): void {
    approvedCount++;
}

export function incrementBlocked(): void {
    blockedCount++;
}

export function resetCounts(): void {
    approvedCount = 0;
    blockedCount = 0;
}

export function disposeStatusBar(): void {
    statusBarItem?.dispose();
}
