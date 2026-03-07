import * as vscode from 'vscode';

/**
 * Manages Kiro's own settings (trustedCommands, commandDenylist)
 * as Layer 1 of the hybrid auto-approval approach.
 */

// Default safe command patterns to trust
// Covers common shell commands, dev tools, and package managers
// that Kiro's agent frequently uses. Dangerous variants are
// blocked by the denylist (e.g. "rm -rf /" is denied, but "rm" is trusted).
const DEFAULT_TRUSTED_PATTERNS = [
    // ── Shell basics ──
    'ls *', 'ls',
    'pwd',
    'cd *',
    'echo *',
    'cat *',
    'head *',
    'tail *',
    'less *',
    'more *',
    'wc *',
    'diff *',
    'cmp *',
    'comm *',
    'sort *',
    'uniq *',
    'tr *',
    'cut *',
    'awk *',
    'sed *',
    'grep *',
    'egrep *',
    'fgrep *',
    'find *',
    'which *',
    'whereis *',
    'type *',
    'file *',
    'stat *',
    'du *',
    'df *',
    'basename *',
    'dirname *',
    'readlink *',
    'realpath *',
    'xargs *',
    'tee *',
    'test *',
    '[ *',     // test shorthand
    'true',
    'false',
    'env *',
    'env',
    'export *',
    'source *',
    'printf *',
    'date *',
    'date',
    'uname *',
    'whoami',
    'id',
    'man *',
    'open *',  // macOS open

    // ── File operations (SPECIFIC patterns only — no broad 'rm *' wildcard!) ──
    'mkdir *',
    'touch *',
    'cp *',
    'mv *',
    // rm — specific safe patterns only (NOT 'rm *' — would match 'rm -rf /')
    'rm *.tmp',
    'rm *.log',
    'ln *',
    // chmod — specific safe patterns only (NOT 'chmod *')
    // chown — never auto-trusted

    // ── Download (SPECIFIC patterns — no broad 'curl *' wildcard!) ──
    'tar *',
    'unzip *',
    'zip *',
    'gzip *',
    'gunzip *',
    // curl/wget — NOT auto-trusted (could be 'curl | sh')

    // ── Node.js (specific safe sub-commands with wildcards for pipes/redirects) ──
    'npm run *',
    'npm test*',        // matches: npm test, npm test 2>&1 | tail -10
    'npm start*',       // matches: npm start, npm start -- --port=3000
    'npm install*',     // matches: npm install, npm install --save
    'npm ci*',          // matches: npm ci, npm ci --prefer-offline
    'npm list*',
    'npm ls*',
    'npm outdated*',
    'npm info*',
    'npm pack*',
    'npm version*',
    'npx -y *',
    'npx --yes *',
    'node *',
    'yarn run *',
    'yarn install*',
    'yarn test*',
    'yarn start*',
    'pnpm run *',
    'pnpm install*',
    'pnpm test*',
    'bun *',
    'tsc *',
    'eslint *',
    'prettier *',
    'jest *',
    'vitest *',
    'mocha *',
    'webpack *',
    'vite *',
    'esbuild *',
    'rollup *',
    'next *',
    'ng *',
    'vue *',
    'nuxt *',
    'nx *',
    'turbo *',

    // ── Python (specific safe patterns) ──
    'python *',
    'python3 *',
    'pip install *',
    'pip3 install *',
    'pip list*',
    'pip show *',
    'pipenv *',
    'poetry *',
    'pytest *',
    'mypy *',
    'black *',
    'ruff *',
    'flask *',
    'django-admin *',
    'uvicorn *',

    // ── Git (specific safe operations — NOT broad 'git *') ──
    'git add *',
    'git commit *',
    'git status*',
    'git diff *',
    'git log *',
    'git branch *',
    'git checkout *',
    'git switch *',
    'git stash *',
    'git pull*',
    'git fetch *',
    'git show *',
    'git blame *',
    'git tag *',
    'git remote *',
    'git merge *',
    'git rebase *',
    'git cherry-pick *',
    // NOT: git push --force, git reset --hard

    // ── Other languages ──
    'cargo *',
    'rustc *',
    'go *',
    'java *',
    'javac *',
    'mvn *',
    'gradle *',
    'dotnet *',
    'ruby *',
    'gem *',
    'bundle *',
    'rake *',
    'swift *',
    'swiftc *',
    'php *',
    'composer *',

    // ── Build tools ──
    'make *',
    'cmake *',
    'gcc *',
    'g++ *',
    'clang *',

    // ── Containers (specific safe patterns — NOT broad 'docker *') ──
    'docker build *',
    'docker run *',
    'docker ps*',
    'docker images*',
    'docker logs *',
    'docker-compose *',
    'kubectl get *',
    'kubectl describe *',
    'kubectl logs *',

    // ── macOS / misc ──
    'brew *',
    'defaults *',
    'pbcopy',
    'pbpaste',
    'osascript *',
    'screencapture *',
];

// Dangerous patterns that should always require approval
const DEFAULT_DENYLIST = [
    // ── Filesystem destruction ──
    'rm -rf /',
    'rm -rf ~',
    'rm -rf /*',
    'rm -rf .',
    'rm -r /',
    'rm -r ~',
    'sudo rm',
    'sudo chmod',
    'sudo chown',
    'sudo kill',
    'chmod 777',
    'chmod -R 777',
    'chown -R root:root /',
    'mv / /dev/null',
    'mv ~ /dev/null',
    '> /dev/sda',
    '> /dev/disk',
    'dd if=',
    'mkfs.',
    'shred /dev',
    // ── Pipe to shell ──
    'curl | sh',
    'curl | bash',
    'wget | sh',
    'wget | bash',
    'curl -s | sh',
    'wget -q | sh',
    // ── Git dangerous ──
    'git push --force',
    'git push -f',
    'git reset --hard',
    'git clean -fdx /',
    // ── SQL injection ──
    'drop table',
    'drop database',
    'truncate table',
    'delete from',
    // ── System control ──
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'kill -9',
    'killall',
    ':(){:|:&};:',
    // ── macOS attacks ──
    'security dump-keychain',
    'security delete-keychain',
    'xattr -c ',
    'xattr -d com.apple.quarantine',
    'launchctl load',
    'launchctl submit',
    'crontab -r',
    // ── Environment hijacking ──
    'DYLD_INSERT_LIBRARIES',
    'LD_PRELOAD',
    // ── Reverse shells & exfiltration ──
    '/dev/tcp/',
    'nc -e',
    'ncat -e',
    'base64 -d | sh',
    'history | sh',
    'history | bash',
    // ── Credential access ──
    '.ssh/id_rsa',
    '.aws/credentials',
    'printenv',
    // ── Prompt injection guard ──
    'trustedCommands',     // Block AI from modifying trust settings
    'commandDenylist',     // Block AI from modifying deny settings
];

/**
 * Apply trusted commands and denylist to Kiro's settings.
 * This is the primary mechanism — handles ~90% of approval dialogs.
 */
export async function applyKiroSettings(
    outputChannel: vscode.OutputChannel,
    customTrusted?: string[],
    customDenylist?: string[],
): Promise<boolean> {
    try {
        const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');

        // Set trusted commands (merge defaults with custom)
        const trusted = customTrusted ?? DEFAULT_TRUSTED_PATTERNS;
        await kiroConfig.update('trustedCommands', trusted, vscode.ConfigurationTarget.Global);

        // Set denylist
        const denylist = customDenylist ?? DEFAULT_DENYLIST;
        await kiroConfig.update('commandDenylist', denylist, vscode.ConfigurationTarget.Global);

        outputChannel.appendLine(`⚡ Kiro settings applied:`);
        outputChannel.appendLine(`   Trusted patterns: ${trusted.length}`);
        outputChannel.appendLine(`   Denylist patterns: ${denylist.length}`);
        return true;
    } catch (e) {
        outputChannel.appendLine(`⚠️  Could not set Kiro settings: ${e}`);
        return false;
    }
}

/**
 * Enable full autonomy mode (trust all — use with caution).
 */
export async function setFullAutonomy(
    enabled: boolean,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    try {
        const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');
        if (enabled) {
            await kiroConfig.update('trustedCommands', ['*'], vscode.ConfigurationTarget.Global);
            outputChannel.appendLine('⚠️  Full autonomy: trustedCommands = ["*"]');
        } else {
            await kiroConfig.update('trustedCommands', DEFAULT_TRUSTED_PATTERNS, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine('✅ Restored safe trusted command patterns');
        }
    } catch (e) {
        outputChannel.appendLine(`Error setting autonomy: ${e}`);
    }
}

/**
 * Add a custom pattern to trusted commands.
 */
export async function addTrustedPattern(
    pattern: string,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    try {
        const kiroConfig = vscode.workspace.getConfiguration('kiroAgent');
        const current = kiroConfig.get<string[]>('trustedCommands', []);
        if (!current.includes(pattern)) {
            current.push(pattern);
            await kiroConfig.update('trustedCommands', current, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine(`✅ Added trusted pattern: "${pattern}"`);
        }
    } catch (e) {
        outputChannel.appendLine(`Error adding trusted pattern: ${e}`);
    }
}

export { DEFAULT_TRUSTED_PATTERNS, DEFAULT_DENYLIST };
