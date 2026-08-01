# fm-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for Apple Foundation Models on macOS. It bridges ACP hosts (Zed, VS Code ACP clients, Devin Desktop, …) to:

1. **`/usr/bin/fm serve --socket`** — **preferred** OpenAI-compatible local server (system + PCC when the server is started in Terminal.app)
2. **`afm`** ([Foundation-Models-Framework-CLI](https://github.com/rudrankriyam/Foundation-Models-Framework-CLI)) — fallback CLI
3. **System `/usr/bin/fm respond`** — direct spawn fallback (no native addons)
4. **`fm-acp-terminal-helper`** — legacy; **not a reliable PCC path** (child `fm respond` still loses Terminal attribution)

```
Terminal.app (once):
  fm serve --socket ~/.config/fm-acp/fm.sock

ACP host  <--stdio NDJSON-->  fm-acp  <--HTTP over UDS-->  fm serve
                                 |
                                 +-- fallbacks: afm | fm respond | helper (legacy)
```

## Prerequisites

- macOS 26+ (27+ for system `fm` / PCC)
- Apple Silicon with Apple Intelligence enabled
- Node.js 20+
- **Either** system `fm` at `/usr/bin/fm` **or** `afm` on `PATH`

Optional (recommended):

```bash
brew tap rudrankriyam/tap
brew install afm
```

## PCC (recommended): Terminal-hosted `fm serve`

PCC is available to **external clients** when `fm serve` itself runs under Terminal.app:

```bash
# Manual (always works):
mkdir -p ~/.config/fm-acp
# In Terminal.app:
fm serve --socket ~/.config/fm-acp/fm.sock

export FM_ACP_SERVE_SOCK=~/.config/fm-acp/fm.sock
```

### Auto-start (opt-in)

Set `FM_ACP_AUTO_SERVE=1` in the ACP host env. On first use fm-acp will try, in order:

1. **`cua-driver`** `launch_app` Terminal + `additional_arguments` pointing at `~/.config/fm-acp/start-fm-serve.command` (validated PCC path)
2. **`open -a Terminal`** that same launcher script

```json
{
  "agent_servers": {
    "fm": {
      "type": "custom",
      "command": "node",
      "args": ["/Users/tariqwest/Developer/fm-acp/bin/fm-acp.mjs"],
      "env": {
        "FM_ACP_SERVE_SOCK": "/Users/tariqwest/.config/fm-acp/fm.sock",
        "FM_ACP_AUTO_SERVE": "1"
      }
    }
  }
}
```

Requires `cua-driver` on PATH for the preferred path (`curl -fsSL https://cua.ai/driver/install.sh | bash`). Without it, `open -a Terminal` is used.

Validated: non-Terminal `fm serve` serves **system** only; Terminal-hosted `fm serve` serves **system + pcc**. `osascript do script` is **not** reliable. Helper `fm respond` under Terminal still fails PCC for the child.

## Run

```bash
cd fm-acp
pnpm install
pnpm start          # ACP over stdio
# or
node bin/fm-acp.mjs
```

Smoke:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node bin/fm-acp.mjs
```

## Host setup (Zed example)

```json
{
  "agent_servers": {
    "fm": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/fm-acp/bin/fm-acp.mjs"],
      "env": {}
    }
  }
}
```

## Legacy Terminal helper

The old `fm-acp-terminal-helper` path (spawn `fm respond` under Terminal) is **not a reliable PCC path** and is kept only as a last-resort fallback. Prefer Terminal-hosted `fm serve` (manual or `FM_ACP_AUTO_SERVE=1`).

When fm-acp handles a PCC turn it tries, in order:

1. **`fm serve --socket`** (if healthy — preferred; auto-start if `FM_ACP_AUTO_SERVE=1`)
2. **Foundation Lab Agent Bridge** (`~/.afm/bridge/connection.json` loopback HTTP, or `afm bridge` CLI if present)
3. **helper** / direct `fm respond` (legacy best-effort; usually fails PCC)

## Config options

| id | Purpose |
|---|---|
| `model` | `system` \| `pcc` |
| `backend` | `auto` \| `afm` \| `fm` (fm path uses helper → fm-wrap; PCC prefers helper) |
| `instructions` | System instructions |
| `use_case` | `general` \| `content-tagging` |
| `guardrails` | `default` \| `permissive-content-transformations` |
| `greedy` | boolean (system `fm`) |
| `bridge` | Prefer Foundation Lab Agent Bridge / `afm bridge` for PCC |

## Environment

| Variable | Description |
|---|---|
| `AFM_BIN` / `AFM_BIN_PATH` | Path to `afm` |
| `AFM_BRIDGE_DESCRIPTOR` | Path to Lab `connection.json` (default `~/.afm/bridge/connection.json`) |
| `AFM_BRIDGE_BASE` | Lab Agent Bridge base folder (default `~/.afm`) |
| `FM_BIN` / `FM_BIN_PATH` | Path to `fm` (default `/usr/bin/fm`) |
| `AFM_EXTRA_ARGS` | Extra args for every `afm` invocation |
| `FM_EXTRA_ARGS` | Extra args for every `fm` invocation |
| `XDG_CONFIG_HOME` | Config root (`$XDG_CONFIG_HOME/fm-acp`) |
| `FM_ACP_SERVE_SOCK` | `fm serve --socket` path (default `~/.config/fm-acp/fm.sock`) |
| `FM_ACP_AUTO_SERVE` | `1` to auto-launch Terminal-hosted `fm serve` via cua-driver / `open -a Terminal` |
| `FM_ACP_AUTO_SERVE_TIMEOUT_MS` | Wait for serve health after auto-launch (default `12000`) |
| `FM_ACP_SERVE_LAUNCHER` | Path to `start-fm-serve.command` (default under config dir) |
| `CUA_DRIVER_BIN` / `CUA_DRIVER_PATH` | Optional absolute path to `cua-driver` |
| `FM_ACP_HELPER_SOCK` | Legacy helper Unix socket path |
| `FM_ACP_HELPER_LOG` | Helper log file |
| `FM_ACP_HELPER_PID` | Helper PID file |
| `FM_ACP_AUTO_BOOTSTRAP` | `1` to allow AppleScript helper launch (legacy; prefer `fm serve`) |
| `FM_ACP_AUTO_BOOTSTRAP_TIMEOUT_MS` | Helper socket wait after launch (ms) |

Sessions: `~/.config/fm-acp/sessions.json`  
Transcripts (fm backend): `~/.config/fm-acp/transcripts/<sessionId>.json`

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm start
```

## Notes / limits

- On-device model is small (~3B); not a full coding agent replacement.
- PCC from GUI-launched hosts needs Terminal-hosted `fm serve --socket` (recommended). **Homebrew `afm` 0.1.0 is on-device only** (no `bridge`/`available`). Foundation Lab is signed with `com.apple.developer.private-cloud-compute` and historically hosted Agent Bridge (`connection.json` + bearer loopback); upstream removed that surface from Lab `main` on 2026-07-01 — see `.agents/research/afm-lab-pcc-findings.md`. Spawning `fm respond` from a Node helper under Terminal still fails PCC. A PTY does **not** satisfy Apple's ancestry check.
- Keep logs on stderr only — stdout is ACP JSON-RPC.

## License

MIT
