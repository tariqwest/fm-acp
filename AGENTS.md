# fm-acp

TypeScript ACP stdio adapter for Apple Foundation Models (`fm serve` + `afm` + system `fm`).

## Setup

```bash
pnpm install
chmod +x bin/fm-acp.mjs bin/fm-acp-terminal-helper.mjs bin/runtime.mjs
bun test
bun run typecheck
```

## Architecture

- `src/index.ts` — ACP SDK stdio handlers
- `src/adapter.ts` — session lifecycle + prompt orchestration
- `src/backends/fm-serve.ts` — HTTP/1.1 over Unix socket to `fm serve` (**preferred**)
- `src/backends/afm.ts` — afm CLI session (on-device); optional bridge CLI fallback
- `src/backends/lab-bridge.ts` — Foundation Lab Agent Bridge via `connection.json` HTTP
- `src/backends/fm.ts` — direct `/usr/bin/fm respond` spawn (no native addons)
- `src/backends/helper.ts` — legacy Terminal helper client (not a reliable PCC path)
- `src/backends/resolve.ts` — routing: **serve → afm/fm → helper**
- `src/serve-bootstrap.ts` — default-on Terminal `fm serve` via cua-driver ensure + launch / `open -a Terminal`
- `src/cua-driver.ts` — resolve/install `cua-driver` (official installer; not an npm CLI)
- `src/session-id.ts` / `src/private-fs.ts` / `src/session-store.ts` — UUID IDs, 0700/0600 state
- `src/map.ts` — transcript/history → ACP updates
- `src/config-options.ts` — model/backend/instructions/…
- Helper modules remain for legacy PCC experiments only

## Rules

- Stdout is ACP only; log to stderr.
- Prefer **Bun** for local dev/test (`bun test`, `bun run start`). Keep **Node+tsx** entrypoints for npm/npx and `FM_ACP_RUNTIME=node`.
- Prefer Terminal-hosted `fm serve --socket` (`FM_ACP_SERVE_SOCK`, default `~/.config/fm-acp/fm.sock`).
- PCC: only validated when **`fm serve` itself** runs under Terminal.app. External clients then get system+pcc. Background `fm serve` is system-only.
- Happy-path auto-start (default ON): `src/serve-bootstrap.ts` ensures **cua-driver** (postinstall + runtime), then `launch_app` Terminal+`additional_arguments` (preferred) then `open -a Terminal`. Disable with `FM_ACP_AUTO_SERVE=0`. Do **not** use osascript `do script`.
- `cua-driver` is a **required runtime dependency** for the happy path; there is no npm CLI package—use `https://cua.ai/driver/install.sh` (or `pnpm run ensure:cua-driver`).
- Helper spawning `fm respond` under Terminal still fails PCC for the child — do not treat helper as primary PCC.
- Homebrew `afm` 0.1.0 has **no** `bridge`/`available`; do not probe those. On-device via `model status` + `session`.
- Lab Agent Bridge (signed app entitlement) is the designed non-Terminal PCC alternative; not operable until Lab exposes a running bridge host + descriptor. Details: `.agents/research/afm-lab-pcc-findings.md`.
- A PTY alone does **not** unlock PCC. No parent-spoofing / process injection.
- No `fm-access-pcc` / `node-pty` runtime dependency.
- Multi-turn: serve uses message history; fm fallback uses `--save-transcript`/`--resume`; afm uses ACP-side history.
- Do not parse interactive `fm chat` TUI.
- Session IDs must be UUIDs; unknown prompt sessions error; overlapping prompts return busy.

## PCC operator flow

```bash
pnpm install   # postinstall ensures cua-driver when missing
pnpm start     # auto-starts Terminal-hosted fm serve via cua-driver by default

# Manual override still works:
# fm serve --socket ~/.config/fm-acp/fm.sock
```

## Commands used

- `fm serve --socket …` → `/health`, `/v1/models`, `/v1/chat/completions`
- `fm available` / `fm respond …`
- `afm model status` / `afm session …` (on-device; Homebrew 0.1.0)
- Lab Agent Bridge `~/.afm/bridge/connection.json` when enabled (PCC candidate)

## Release

Use the coupled release script (GitHub + Homebrew unless opted out):

```bash
bun run release
bun run release -- --github-only
bun run release -- --homebrew-only
```

