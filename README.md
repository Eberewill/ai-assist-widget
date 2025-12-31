# AI Assist Widget

Electron + Vite overlay that captures the screen and sends it to Gemini for a quick solution.

## Requirements
- Node.js 18+
- Gemini API key

## Setup
```bash
npm install
npm run dev
```

## Notes
- macOS: enable Screen Recording for the app in System Settings > Privacy & Security > Screen Recording.
- Set `ASSISTANT_DEBUG_CAPTURES=1` to save screenshots under your user data directory.
- Model name is configurable in settings if your API key doesn't support the default.
