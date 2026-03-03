# AI Assist Widget

Lightweight macOS overlay assistant built with Electron + React + Vite.

It captures your screen context (or selected text), sends the prompt to your chosen AI provider, and returns concise technical help in a floating widget.

## Features
- Quick Solve from screen capture
- Deep Analysis with screenshot + accessibility semantic structure
- Follow-up chat with optional image attachments
- Multiple providers:
  - Codex CLI (default)
  - Gemini API
  - Kimi API
  - Kimi Code CLI
- Ghost Mode (selected text extraction)
- Stealth Mode (minimized focus-stealing behavior)

## Platform Support
- macOS only (current implementation depends on Apple Screen Recording + Accessibility APIs)

## Requirements
- Node.js 18+
- npm
- Python 3 (for accessibility bridge)
- Python package: `atomacos`

Install Python dependency:

```bash
python3 -m pip install atomacos
```

Provider requirements:
- Codex: `codex` CLI installed and authenticated (`codex login`)
- Gemini: API key from Google AI Studio
- Kimi: API key from Moonshot/Kimi platform
- Kimi Code: `kimi` CLI installed and authenticated

## Quick Start
```bash
npm install
npm run dev
```

This starts Vite and Electron together (via `vite-plugin-electron`).

## First-Run Permissions (macOS)
1. Enable **Screen Recording** for the app in:
   `System Settings > Privacy & Security > Screen Recording`
2. For Ghost Mode / semantic extraction, enable **Accessibility** if prompted.

## Usage
1. Open the widget.
2. Choose provider and model in Settings.
3. Add API keys (Gemini/Kimi) if needed.
4. Click:
   - `Quick Solve` for screenshot-based help
   - `Deep Analysis` for screenshot + semantic structure
   - `Solve Text` when using Kimi Code mode

## Configuration
- `ASSISTANT_DEBUG_CAPTURES=1`
  - Saves screenshots into Electron user data under `debug_captures/`
- `CODEX_PATH`, `KIMI_PATH`, `PYTHON_PATH`
  - Optional overrides for CLI/Python executable resolution

## Project Structure
- `electron/main.ts` - Electron main process, capture, provider routing, IPC handlers
- `electron/preload.ts` - secure IPC bridge
- `src/components/AssistantWidget.tsx` - overlay UI and interaction flows
- `python/bridge.py` - macOS accessibility and selected-text bridge

## Development
- `npm run dev` - run app in development
- `npm run build` - type-check and build renderer + Electron bundles
- `npm run lint` - run ESLint

## Privacy Notes
- Screenshots are processed in memory by default.
- Debug screenshots are only written when `ASSISTANT_DEBUG_CAPTURES=1`.
- API keys are stored locally in browser `localStorage` for convenience.

## Contributing
Issues and pull requests are welcome.

Before opening a PR:
1. Run `npm run lint`
2. Run `npm run build`
3. Include a clear summary and screenshots/GIFs for UI changes

For contribution workflow details, see `CONTRIBUTING.md`.

## License
MIT. See `LICENSE`.
