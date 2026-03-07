import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface AutoRunConfig {
    enabled: boolean;
    pollInterval: number;
    targetApp: string;
    triggerTexts: string[];
    bannedKeywords: string[];
    showNotification: boolean;
    notificationSound: boolean;
    stuckRecoveryEnabled: boolean;
}

const SECTION = 'kiroAutorun';
const CONFIG_DIR = path.join(os.homedir(), '.kiro-autorun');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const ACTION_LOG_FILE = path.join(CONFIG_DIR, 'actions.log');

export function getConfig(): AutoRunConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);

    // Support both single triggerText (legacy) and triggerTexts array
    let triggerTexts = cfg.get<string[]>('triggerTexts', []);
    if (triggerTexts.length === 0) {
        const single = cfg.get<string>('triggerText', 'waiting on your input');
        triggerTexts = [single];
    }

    return {
        enabled: cfg.get<boolean>('enabled', true),
        pollInterval: cfg.get<number>('pollInterval', 2),
        targetApp: cfg.get<string>('targetApp', 'Kiro'),
        triggerTexts,
        bannedKeywords: cfg.get<string[]>('bannedKeywords', []),
        showNotification: cfg.get<boolean>('showNotification', false),
        notificationSound: cfg.get<boolean>('notificationSound', true),
        stuckRecoveryEnabled: cfg.get<boolean>('stuckRecoveryEnabled', true),
    };
}

export async function setConfigValue<K extends keyof AutoRunConfig>(
    key: K, value: AutoRunConfig[K],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

export function writeConfigFile(config: AutoRunConfig): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function onConfigChange(callback: (config: AutoRunConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
            const newConfig = getConfig();
            writeConfigFile(newConfig);
            callback(newConfig);
        }
    });
}
