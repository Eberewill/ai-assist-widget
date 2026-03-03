# Contributing

Thanks for contributing to AI Assist Widget.

## Development Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run in development:
   ```bash
   npm run dev
   ```

## Pull Request Checklist
1. Keep changes focused and scoped to a clear problem.
2. Run:
   ```bash
   npm run lint
   npm run build
   ```
3. Verify major flows manually:
   - Quick Solve
   - Deep Analysis
   - Follow-up chat
   - Settings save/load for your touched provider
4. Add screenshots or short screen recordings for UI changes.
5. Include a concise PR description with:
   - what changed
   - why it changed
   - any limitations or follow-ups

## Style Notes
- Keep renderer code TypeScript-strict and avoid `any` where possible.
- Preserve the existing IPC safety pattern (`allowedChannels` in preload).
- Avoid logging sensitive values (API keys, raw request/response payloads).
- Keep comments short and only where logic is non-obvious.

## Reporting Issues
When filing issues, include:
1. macOS version
2. provider used (Codex/Gemini/Kimi/Kimi Code)
3. steps to reproduce
4. expected vs actual behavior
5. relevant logs or error messages (with secrets removed)
