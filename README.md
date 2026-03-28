# Kiro AutoRun

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/ANLE.kiro-autorun?style=for-the-badge&logo=visual-studio-code&logoColor=white&label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)
[![GitHub Release](https://img.shields.io/github/v/release/anlvdt/kiro-autorun?style=for-the-badge&logo=github&label=Release)](https://github.com/anlvdt/kiro-autorun/releases/latest)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ANLE.kiro-autorun?style=for-the-badge&logo=visual-studio-code&logoColor=white&color=28a745)](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)
[![License](https://img.shields.io/github/license/anlvdt/kiro-autorun?style=for-the-badge)](LICENSE.md)

100% Native, zero-overhead auto-approval for Kiro IDE command prompts with banned-keyword safety. **macOS, Windows, & Linux.**

## The Problem

Kiro IDE requires manual approval for commands the AI agent runs. This creates frustrating interruptions:

- **"Waiting on your input"** panel appears continuously, breaking focus and flow.
- **"Accept All / Reject All"** prompts block tasks endlessly.
- **Lost Sessions** hang indefinitely awaiting action if you step away.
- Built-in `trustedCommands` can be buggy, fails occasionally, and requires constant manual maintenance.

## How It Works: Layer 0 Native Architecture

Kiro AutoRun has evolved from an OCR-based system into a **100% Native TypeScript Layer 0 API Integration**. 

Instead of reading the screen or taking over your mouse, it hooks directly into Kiro's internal execution state.

- **Zero Overhead**: No Python, no heavy OCR, 0% CPU consumption.
- **Zero Interruption**: Interacts instantly inside the VS Code backend—your cursor and window focus remain completely unaffected.
- **100% Accurate**: Checks internal command strings via Kiro IDE's `kiroAgent.executions.getExecutions` API natively, avoiding visual false positives.
- **Universal OS Support**: Since it runs purely within the TypeScript extension host, it works out-of-the-box on macOS, Windows, Linux, and Remote Workspaces!

## Key Features

- **Layer 0 Native APIs** - Instantly reads internal pending executions and invokes `executeCommand('kiroAgent.execution.runOrAcceptAll')` directly.
- **Smart safety (Deny-list)** - 70+ cross-platform banned keywords (Linux, macOS, Windows) are intercepted. Inherently dangerous commands (like `rm -rf /`, `curl | bash`, or PowerShell exploits) are blocked *before* they can run.
- **Auto-learning (Machine Memory)** - Tracks how often a specific tool/command is invoked safely. Once a command proves benign repeatedly, it is dynamically learned and added to Kiro's internal `trustedCommands`.
- **NEVER_LEARN strict guard** - Highly dangerous base commands (`rm`, `sudo`, `curl`) are systematically guarded and will *never* be auto-trusted.
- **Premium Ops Dashboard** - A modern, glassmorphic UI integrated right inside Kiro to visualize your approval metrics, blocked commands, and up-time gracefully.

## Installation

### From Marketplace (Recommended)

**[Install from Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)**

Or search for **"Kiro AutoRun"** in the Extensions panel (`Cmd+Shift+X`).

### From GitHub Releases

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/anlvdt/kiro-autorun/releases/latest)
2. In Kiro/VS Code: Extensions > `...` > **Install from VSIX** > select the downloaded file

## Settings

| Setting | Default | Description |
|---|---|---|
| `kiroAutorun.enabled` | `true` | Enable/disable Native auto-approval |
| `kiroAutorun.pollInterval` | `2` | Seconds between checking the internal execution queue |
| `kiroAutorun.bannedKeywords` | *(70+ dangerous patterns)* | If any execute natively, auto-run is **blocked** |

*Legacy targetApp, OCR limits, and Recovery settings have been permanently retired due to the modern Native architecture.*

## Commands

| Command | Description |
|---|---|
| **Kiro AutoRun: Toggle ON/OFF** | Toggle via command palette or status bar click |
| **Kiro AutoRun: Show Command History** | Access the sleek Native API Dashboard log |
| **Kiro AutoRun: Clear History** | Clear the Ops Dashboard history |
| **Kiro AutoRun: Add Banned Keyword** | Add a keyword to the deny list |
| **Kiro AutoRun: Add Trusted Command Pattern** | Add a pattern manually |
| **Kiro AutoRun: Dump Available Commands** | Discovery tool to dump all internal API definitions |

## Safety Features

- **Banned keywords** - intercepts native command streams prior to execution approval.
- **Pipe-to-shell detection** - denies obscure background executions routing to untrusted bins. 
- **NEVER_LEARN** - strictly denies training behavior against OS-level destruction patterns.
Default banned keywords include: `rm -rf`, `sudo rm`, `chmod 777`, `curl | sh`, `git push --force`, `drop table`, `shutdown`, `kill -9`, PowerShell `ExecutionPolicy Bypass`, reverse shells, etc.

## Author

**Le Van An** (Vietnam IT)

[![GitHub](https://img.shields.io/badge/GitHub-anlvdt-181717?style=for-the-badge&logo=github)](https://github.com/anlvdt)

## Support

If you find this project useful and it saves you hours of clicking, consider supporting the author!

### Bank Transfer

| Method | Account | Name |
|--------|---------|------|
| MB Bank | `0360126996868` | LE VAN AN |
| Momo | `0976896621` | LE VAN AN |

### Shopee Affiliate

[![Shopee](https://img.shields.io/badge/Shopee-EE4D2D?style=for-the-badge&logo=shopee&logoColor=white)](https://s.shopee.vn/7AYWh5NzOB)

**[View products on Shopee](https://s.shopee.vn/7AYWh5NzOB)** - Just one click helps! Thank you!

## License

MIT License - Copyright (c) 2026 Le An (Vietnam IT)
