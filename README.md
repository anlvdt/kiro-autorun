# Kiro AutoRun

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/ANLE.kiro-autorun?style=for-the-badge&logo=visual-studio-code&logoColor=white&label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)
[![GitHub Release](https://img.shields.io/github/v/release/anlvdt/kiro-autorun?style=for-the-badge&logo=github&label=Release)](https://github.com/anlvdt/kiro-autorun/releases/latest)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ANLE.kiro-autorun?style=for-the-badge&logo=visual-studio-code&logoColor=white&color=28a745)](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)
[![License](https://img.shields.io/github/license/anlvdt/kiro-autorun?style=for-the-badge)](LICENSE.md)

Smart auto-approval for Kiro IDE command prompts with banned-keyword safety. **macOS & Windows.**

## The Problem

Kiro IDE requires manual approval for commands the AI agent runs. This creates frustrating interruptions:

- **"Waiting on your input"** panel appears with slow delay, blocking workflow ([#3447](https://github.com/kirodotdev/Kiro/issues/3447))
- **"Accept All / Reject All"** prompts on every task start (Kiro v0.8+)
- **Buttons disappear** or don't appear at all ([#2969](https://github.com/kirodotdev/Kiro/issues/2969), [#2875](https://github.com/kirodotdev/Kiro/issues/2875))
- **Trust causes loops** - choosing "Trust" gets stuck in "waiting on input" loop ([#2946](https://github.com/kirodotdev/Kiro/issues/2946))
- **Sessions hang** on "Waiting on your input" with no action needed ([#2146](https://github.com/kirodotdev/Kiro/issues/2146))
- **No notification sound** when Kiro needs attention ([#308](https://github.com/kirodotdev/Kiro/issues/308))
- Built-in `trustedCommands` can be buggy - fails with `;` in commands, inconsistent across versions

## How It Works

**Hybrid 2-layer approach:**

- **Layer 1 (Settings API)**: Automatically configures Kiro's `trustedCommands` and `commandDenylist` settings with 100+ safe patterns. Handles ~90% of approval dialogs natively.
- **Layer 2 (OCR + Click)**: A Python backend detects "Waiting on your input" text via OCR, locates the **Run/Accept All** button, and clicks it — with click guard (bounds check) and cooldown.
  - **macOS**: Vision framework OCR + CGEvent click (cursor save/restore)
  - **Windows**: WinRT OCR (built-in) + UI Automation API (preferred) / position-based click fallback. Scans ALL Kiro windows. Button priority: Run > Accept All > Reject All > Trust.

```
+----------------------------------------------+
|  VS Code Extension (TypeScript)              |
|  +- Layer 1: Kiro trustedCommands settings   |
|  +- Config management (VS Code settings)     |
|  +- Status bar (ON/OFF + counts)             |
|  +- Auto-learn safe patterns                 |
|  +- Polls action log from Python backend     |
|                                              |
|  Python Backend (auto-launched)              |
|  +- OCR: "Waiting on your input" detection   |
|  +- OCR-position button finding (Run/Trust)  |
|  +- Smart click (UIA / CGEvent / SendMsg)    |
|  +- Smart command safety analysis            |
|  +- Anti-loop: screen state hashing          |
|  +- Stuck recovery: log after timeout        |
|  +- Alert sound on blocked commands          |
|  +- Logs: JSON-lines action file             |
+----------------------------------------------+
```

## Key Features

- **No cursor movement** - macOS: CGEvent with cursor save/restore; Windows: UI Automation API (primary), position-based click (fallback)
- **Multi-window scanning** - scans all Kiro windows to find active prompts
- **Background operation** - works while Kiro is behind other windows
- **Cross-platform** - macOS (Vision + Quartz) and Windows (WinRT + Win32)
- **Smart safety** - 28+ banned keywords, inherently dangerous commands blocked, pipe-to-shell detection
- **Auto-learning** - learns safe command patterns and adds to Kiro's trustedCommands
- **NEVER_LEARN list** - dangerous base commands (rm, sudo, curl, etc.) are never auto-trusted
- **Click guard** - verifies target coordinates are inside Kiro window, with 30px edge margin
- **Anti-loop** - screen hash cooldown prevents re-clicking same prompt
- **Alert sound** - audio notification when a command is blocked

## Requirements

### macOS

- **macOS 10.15+** (uses Vision framework + Quartz for screen capture and CGEvent for clicking)
- **Terminal.app** must have **Accessibility** and **Screen Recording** permissions
- Python 3 with `pyobjc-framework-Quartz` and `pyobjc-framework-Vision`

```bash
pip3 install pyobjc-framework-Quartz pyobjc-framework-Vision
```

### Windows

- **Windows 10/11**
- **Python 3.10+** — [Download](https://www.python.org/downloads/) or `winget install Python.Python.3.12`
- Python packages:

```bash
pip install pywin32 Pillow winrt-runtime winrt-Windows.Media.OCR winrt-Windows.Graphics.Imaging winrt-Windows.Globalization winrt-Windows.Storage.Streams comtypes
```

| Package | Purpose |
|---------|--------|
| `pywin32` | Win32 API — window finding, screen capture, DWM rect |
| `Pillow` | Image processing |
| `winrt-runtime` + `winrt-Windows.*` | Windows built-in OCR (WinRT) |
| `comtypes` | UI Automation API — click buttons without cursor movement |

> **Note:** `winocr` or `pytesseract` can be used as alternative OCR engines if the WinRT packages are unavailable.

## Installation

### From Marketplace (Recommended)

**[Install from Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ANLE.kiro-autorun)**

Or search for **"Kiro AutoRun"** in the Extensions panel (`Cmd+Shift+X`).

### From GitHub Releases

1. Download the latest `.vsix` file from [GitHub Releases](https://github.com/anlvdt/kiro-autorun/releases/latest)
2. In Kiro/VS Code: Extensions > `...` > **Install from VSIX** > select the downloaded file

### Build from Source

```bash
cd kiro-autorun
npm install
npm run compile
npm run package

# Install the generated .vsix in Kiro/VS Code
# Extensions > ... > Install from VSIX
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `kiroAutorun.enabled` | `true` | Enable/disable auto-approval |
| `kiroAutorun.pollInterval` | `2` | Seconds between each screen check |
| `kiroAutorun.targetApp` | `"Kiro"` | Process name of the target IDE |
| `kiroAutorun.triggerTexts` | `["waiting on your input"]` | OCR texts that trigger auto-click |
| `kiroAutorun.bannedKeywords` | *(26 dangerous patterns)* | If any appear on screen, auto-click is **blocked** |
| `kiroAutorun.showNotification` | `false` | Show macOS notifications on auto-click/block |
| `kiroAutorun.notificationSound` | `true` | Play alert sound when command is blocked |
| `kiroAutorun.stuckRecoveryEnabled` | `true` | Log warning after ~10s stuck with no button |

## Commands

| Command | Description |
|---|---|
| **Kiro AutoRun: Toggle ON/OFF** | Toggle via command palette or status bar click |
| **Kiro AutoRun: Show Command History** | View all logged commands |
| **Kiro AutoRun: Clear History** | Clear the command log |
| **Kiro AutoRun: Add Banned Keyword** | Add a keyword to the deny list |
| **Kiro AutoRun: Add Trusted Command Pattern** | Add a pattern to Kiro's trustedCommands |
| **Kiro AutoRun: Toggle Full Autonomy** | Trust ALL commands (use with caution) |
| **Kiro AutoRun: Show Output Log** | Show the extension output channel |

## Safety Features

- **Banned keywords** - blocks auto-click when dangerous commands detected on screen
- **Smart command analysis** - detects inherently dangerous commands, pipe-to-shell, force flags
- **NEVER_LEARN** - prevents auto-trusting dangerous base commands (rm, sudo, curl, npm, etc.)
- **Anti-loop cooldown** - screen state hashing prevents re-clicking same prompt
- **Click debouncing** - minimum 2s between clicks to prevent rapid double-clicks
- **Click guard** - verifies coordinates are inside Kiro window with edge margins
- **Stuck recovery** - logs warning after prolonged stuck state, enables position-based click fallback after 5+ stuck cycles
- **Alert sound** - audio notification when a command is blocked

Default banned keywords include: `rm -rf`, `sudo rm`, `chmod 777`, `curl | sh`, `git push --force`, `git reset --hard`, `drop table`, `shutdown`, `kill -9`, `killall`, fork bomb, reverse shells, credential access, and more.

## Author

**Le Van An** (Vietnam IT)

[![GitHub](https://img.shields.io/badge/GitHub-anlvdt-181717?style=for-the-badge&logo=github)](https://github.com/anlvdt)

## Support

If you find this project useful, consider supporting the author.

### Bank Transfer

| Method | Account | Name |
|--------|---------|------|
| MB Bank | `0360126996868` | LE VAN AN |
| Momo | `0976896621` | LE VAN AN |

### Shopee Affiliate

[![Shopee](https://img.shields.io/badge/Shopee-EE4D2D?style=for-the-badge&logo=shopee&logoColor=white)](https://s.shopee.vn/7AYWh5NzOB)

**[View products on Shopee](https://s.shopee.vn/7AYWh5NzOB)** - Just one click helps! Thank you!

### Other ways to support

- Star the repo on GitHub
- Share with friends and colleagues
- Report bugs or suggest features via Issues

## License

MIT License - Copyright (c) 2026 Le An (Vietnam IT)
