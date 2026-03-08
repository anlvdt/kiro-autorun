import * as vscode from 'vscode';
import { AutoRunConfig } from './config';

let statusBarItem: vscode.StatusBarItem;
let approvedCount = 0;
let blockedCount = 0;
let lastActionTime: number | null = null;
let startTime: number | null = null;
let backendHealthy = true;

function relativeTime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) { return `${sec}s ago`; }
    const min = Math.floor(sec / 60);
    if (min < 60) { return `${min}m ago`; }
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m ago`;
}

function uptimeStr(): string {
    if (!startTime) { return 'not started'; }
    const sec = Math.floor((Date.now() - startTime) / 1000);
    if (sec < 60) { return `${sec}s`; }
    const min = Math.floor(sec / 60);
    if (min < 60) { return `${min}m`; }
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
}

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
        const healthIcon = backendHealthy ? '' : ' ⚠';
        statusBarItem.text = `$(zap) AutoRun ON${stats}${healthIcon}`;
        statusBarItem.backgroundColor = backendHealthy ? undefined :
            new vscode.ThemeColor('statusBarItem.errorBackground');
        statusBarItem.color = backendHealthy ? '#3fb950' : undefined;

        const lastStr = lastActionTime
            ? relativeTime(Date.now() - lastActionTime)
            : 'none yet';
        const healthStr = backendHealthy ? '✓ Healthy' : '⚠ Backend lost — try restarting';

        statusBarItem.tooltip = [
            '⚡ Kiro AutoRun — Ops Monitor',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `✓ Approved: ${approvedCount}`,
            `✕ Blocked: ${blockedCount}`,
            `⏱ Uptime: ${uptimeStr()}`,
            `🕐 Last action: ${lastStr}`,
            `🔌 Backend: ${healthStr}`,
            `🛡 Banned keywords: ${config.bannedKeywords.length}`,
            `⏲ Poll interval: ${config.pollInterval}s`,
            '',
            'Click to disable',
        ].join('\n');
    }

    statusBarItem.show();
}

export function incrementApproved(): void {
    approvedCount++;
    lastActionTime = Date.now();
}

export function incrementBlocked(): void {
    blockedCount++;
    lastActionTime = Date.now();
}

export function resetCounts(): void {
    approvedCount = 0;
    blockedCount = 0;
    lastActionTime = null;
}

export function setStartTime(): void {
    startTime = Date.now();
}

export function setBackendHealth(healthy: boolean): void {
    backendHealthy = healthy;
}

export function isBackendHealthy(): boolean {
    return backendHealthy;
}

export function disposeStatusBar(): void {
    statusBarItem?.dispose();
}
