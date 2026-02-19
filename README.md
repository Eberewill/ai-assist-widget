# AI Assist Widget

Electron + Vite overlay that captures the screen and routes analysis through Codex CLI.

## Requirements
- Node.js 18+
- Codex CLI installed (`codex --version`)
- Codex authenticated (`codex login`)

## Setup
```bash
npm install
npm run dev
```

## Notes
- macOS: enable Screen Recording for the app in System Settings > Privacy & Security > Screen Recording.
- Captures are processed in memory by default.
- Set `ASSISTANT_DEBUG_CAPTURES=1` to save screenshots under the Electron user-data directory (`.../debug_captures`).
- Model name is configurable in settings if you want to target a different Codex/OpenAI model.
