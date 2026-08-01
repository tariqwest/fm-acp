# fm-acp

TypeScript ACP stdio adapter for Apple Foundation Models (`afm` + system `fm`).

## Setup

```bash
pnpm install
chmod +x bin/fm-acp.mjs bin/fm-acp-terminal-helper.mjs
pnpm test
pnpm typecheck
```

## Architecture

- `src/index.ts` — ACP SDK stdio handlers
- `src/adapter.ts` — session lifecycle + prompt orchestration
- `src/backends/afm.ts` — afm CLI (session stream + bridge)
- `src/backends/fm.ts` — system fm via **fm-wrap** (PTY for pcc) + transcript resume
- `src/backends/helper.ts` — client for the Terminal.app helper daemon
- `src/backends/resolve.ts` — auto backend / PCC routing (`helper → bridge → fm-wrap`)
- `src/helper-protocol.ts` — NDJSON wire protocol for the helper
- `src/helper-socket.ts` — socket/log/pid path resolution + stale cleanup
- `src/helper-bootstrap.ts` — optional AppleScript launch of the helper
- `bin/fm-acp-terminal-helper.mjs` — helper daemon (must run under Terminal.app)
- `src/map.ts` — transcript/history → ACP updates
- `src/session-store.ts` — `~/.config/fm-acp`
- `src/config-options.ts` — model/backend/instructions/…

## Rules

- Stdout is ACP only; log to stderr.
- Prefer `afm` when installed; fall back to `/usr/bin/fm` via **fm-wrap**.
- PCC order: **helper** (if socket live) → **afm bridge** (if enabled) → **fm-wrap PTY**. `backend=fm` skips bridge. Never hang silently.
- A PTY alone does **not** unlock PCC — Apple checks process ancestry, not TTY presence. Do not reintroduce parent-spoofing / process injection.
- Multi-turn: fm uses `--save-transcript`/`--resume`; afm uses ACP-side history (+ optional chat messages).
- Do not parse interactive `fm chat` TUI.
- Helper auto-bootstrap is opt-in via `FM_ACP_AUTO_BOOTSTRAP=1` (AppleScript `tell application "Terminal" … do script`). Default is manual start.

## Helper

```bash
# Manual (preferred): run inside a real Terminal.app window
node bin/fm-acp-terminal-helper.mjs
```

Socket default: `~/.config/fm-acp/helper.sock`  
Env: `FM_ACP_HELPER_SOCK`, `FM_ACP_HELPER_LOG`, `FM_ACP_HELPER_PID`, `FM_ACP_AUTO_BOOTSTRAP`, `FM_ACP_AUTO_BOOTSTRAP_TIMEOUT_MS`

## Commands used

- `afm available --output json`
- `afm session stream|chat --output json …`
- `afm bridge chat --model pcc …`
- `fm available`
- `fm respond --model … [--resume] --save-transcript …`
- `osascript -e 'tell application "Terminal" …'` (optional auto-bootstrap)
