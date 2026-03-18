# Changelog

All notable changes to the "kiro-autorun" extension will be documented in this file.

## [2.1.6] - 2026-03-18
### Added
- Added Visual Studio Marketplace and GitHub Releases download badges to README.
- Added direct install links for Marketplace, GitHub Releases, and build-from-source in Installation section.

## [2.1.5] - 2026-03-16
### Added
- Centralized `NEVER_LEARN` validation to reliably block auto-trusting dangerous commands.

### Fixed
- Enhanced file system watcher to gracefully handle missing `fs.watch` events and improved backend health check polling.

## [2.1.4] - 2026-03-16
### Changed
- Replaced Terminal.app usage with direct `spawn` of the Python backend to provide a seamless, truly background experience.

## [2.1.3] - 2026-03-16
### Fixed
- Fixed false trigger from Settings and README panels.

## [2.1.2] - 2026-03-16
### Added
- Added "Restart Backend" and "Reload Window" commands for easier troubleshooting.
- Added smooth UX features including zero-annoyance click handling, accurate logging counts, and invisible cursor transitions.

### Fixed
- Fixed false trigger when the "Waiting on your input" text appears in the Output panel instead of the main editor terminal.
- Auto-closed the Terminal if it was used for launching the backend.
- Fixed action log parser double-counting old entries.

## [2.1.0] - Prior Release
### Added
- Added CGEvent click guard (bounds check before click).
- Added auto-restart prompt after version update.
- Hidden Python Dock icon (LSUIElement).
- Smart command extraction (last Command block, not first).

### Removed
- Removed all emojis from UI and logs for clean text output.
- Removed dead code (AppleScript fallback).

## [2.0.0] - Prior Release
### Added
- Hybrid 2-layer architecture (Settings API + OCR).
- OCR-position button clicking (replaces AX API for web-rendered buttons).
- CGEvent click with cursor save/restore.
- Smart command safety analysis with NEVER_LEARN list.
- Process deduplication at startup.
