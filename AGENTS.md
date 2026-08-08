# fm-acp

TypeScript ACP stdio adapter for Apple Foundation Models. **PCC and Terminal-hosted `fm serve` live in [`fm-access-pcc`](https://github.com/tariqwest/fm-access-pcc)**; this package is the ACP stdio edge plus `afm` / direct `fm` fallbacks.

## Setup

```bash
pnpm install
chmod +x bin/fm-acp.mjs bin/fm-acp-terminal-helper.mjs bin/runtime.mjs
bun test
bun run typecheck
```

## Architecture

- `src/index.ts` — ACP SDK stdio handlers; applies `FM_ACP_*` → `fm-access-pcc` env bridge
- `src/adapter.ts` — session lifecycle + prompt orchestration
- `src/env-bridge.ts` — maps `FM_ACP_*` onto `FM_ACCESS_PCC_*` and defaults sockets under `~/.config/fm-acp`
- `src/backends/fm-access-pcc.ts` — **primary** PCC/serve path via `fm-access-pcc` (`transportChatCompletion`, `ensureFmServe`, availability)
- `src/backends/afm.ts` — afm CLI session (on-device); optional bridge CLI leftover
- `src/backends/fm.ts` — direct `/usr/bin/fm respond` spawn (system fallback; not PCC)
- `src/backends/helper.ts` — legacy Terminal helper client (not a reliable PCC path)
- `src/backends/resolve.ts` — routing: **fm-access-pcc → afm/fm → helper**
- `src/serve-bootstrap.ts` / `src/cua-driver.ts` / `src/backends/fm-serve.ts` / `src/backends/lab-bridge.ts` — **legacy local copies** kept for unit tests and helper experiments; runtime PCC uses the library
- `src/session-id.ts` / `src/private-fs.ts` / `src/session-store.ts` — UUID IDs, 0700/0600 state
- `src/map.ts` — transcript/history → ACP updates
- `src/config-options.ts` — model/backend/instructions/…

## Rules

- Stdout is ACP only; log to stderr.
- Prefer **Bun** for local dev/test (`bun test`, `bun run start`). Keep **Node+tsx** entrypoints for npm/npx and `FM_ACP_RUNTIME=node`.
- **PCC is implemented in `fm-access-pcc`**, not duplicated here. Depend on the published tarball/release; do not reintroduce a parallel serve bootstrap as the primary path.
- Prefer Terminal-hosted `fm serve --socket` (`FM_ACP_SERVE_SOCK`, default `~/.config/fm-acp/fm.sock` via env bridge).
- PCC: only validated when **`fm serve` itself** runs under Terminal.app. External clients then get system+pcc. Background `fm serve` is system-only.
- Happy-path auto-start (default ON): library `ensureFmServe` (cua-driver + Terminal). Disable with `FM_ACP_AUTO_SERVE=0` (bridged to `FM_ACCESS_PCC_AUTO_SERVE`). Do **not** use osascript `do script`.
- `cua-driver` remains a happy-path runtime dependency (via `fm-access-pcc` + optional local postinstall ensure).
- Helper spawning `fm respond` under Terminal still fails PCC for the child — do not treat helper as primary PCC.
- Homebrew `afm` 0.1.0 has **no** `bridge`/`available`; do not probe those. On-device via `model status` + `session`.
- Lab Agent Bridge is probed inside `fm-access-pcc` when enabled. Details: `.agents/research/afm-lab-pcc-findings.md`.
- A PTY alone does **not** unlock PCC. No parent-spoofing / process injection.
- Do **not** add `node-pty` as a direct dependency of fm-acp.
- Multi-turn: serve uses message history via fm-access-pcc; fm fallback uses `--save-transcript`/`--resume`; afm uses ACP-side history.
- Do not parse interactive `fm chat` TUI.
- Session IDs must be UUIDs; unknown prompt sessions error; overlapping prompts return busy.

## PCC operator flow

```bash
pnpm install   # pulls fm-access-pcc; postinstall may ensure cua-driver
pnpm start     # auto-starts Terminal-hosted fm serve via fm-access-pcc by default

# Manual override still works:
# fm serve --socket ~/.config/fm-acp/fm.sock
# or share with the library:
# export FM_ACCESS_PCC_SERVE_SOCK="$HOME/.config/fm-acp/fm.sock"
```

## Commands used

- `fm-access-pcc` → Terminal `fm serve --socket`, `/health`, `/v1/chat/completions`, optional Lab bridge
- `fm available` / `fm respond …` (system fallback)
- `afm model status` / `afm session …` (on-device; Homebrew 0.1.0)

## Release

Use the coupled release script (GitHub + Homebrew unless opted out):

```bash
bun run release
bun run release -- --github-only
bun run release -- --homebrew-only
```
