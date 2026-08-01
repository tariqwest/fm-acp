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
# In a real Terminal.app window (open -a Terminal works; plain background spawn does not get PCC):
mkdir -p ~/.config/fm-acp
fm serve --socket ~/.config/fm-acp/fm.sock
```

Point fm-acp at that socket (default path above):

```bash
export FM_ACP_SERVE_SOCK=~/.config/fm-acp/fm.sock
```

Validated: non-Terminal `fm serve` serves **system** only; Terminal-hosted `fm serve` serves **system + pcc** to curl/Node clients outside Terminal. A PTY alone is **not** enough. The old helper daemon spawning `fm respond` under Terminal still fails PCC for the child process.

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

## Terminal.app helper (PCC)

Apple's `fm` CLI only allows Private Cloud Compute when a Terminal.app process is an ancestor. GUI-launched hosts (Zed, VS Code, Warp agents, …) fail with:

> Private Cloud Compute is not available in this context. Please use the Terminal app.

`fm-acp` solves this with a small daemon you run **once** inside Terminal.app:

```bash
# From a real Terminal.app window (not iTerm, not a Warp pane):
node /absolute/path/to/fm-acp/bin/fm-acp-terminal-helper.mjs
# or, after pnpm link / global install:
fm-acp-terminal-helper
```

It binds a Unix socket at `~/.config/fm-acp/helper.sock` and logs to `~/.config/fm-acp/helper.log`. Leave the window open (or background the process).

When fm-acp handles a PCC turn it tries, in order:

1. **`fm serve --socket`** (if healthy — preferred)
2. **afm bridge** (if installed and enabled)
3. **helper** / direct `fm respond` (legacy best-effort; often fails PCC ancestry)

### Auto-bootstrap (optional)

Set `FM_ACP_AUTO_BOOTSTRAP=1` in the host environment to let fm-acp launch the helper via AppleScript (`tell application "Terminal" … do script`). macOS will prompt for Accessibility / Automation permission the first time — grant it to the host app (or to Terminal, depending on the prompt).

```json
{
  "agent_servers": {
    "fm": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/fm-acp/bin/fm-acp.mjs"],
      "env": {
        "FM_ACP_AUTO_BOOTSTRAP": "1"
      }
    }
  }
}
```

Manual start is still recommended for day-to-day use; auto-bootstrap is a convenience for first-run setups.

### Helper env

| Variable | Description |
|---|---|
| `FM_ACP_HELPER_SOCK` | Socket path (default `~/.config/fm-acp/helper.sock`) |
| `FM_ACP_HELPER_LOG` | Log file (default sibling `helper.log`) |
| `FM_ACP_HELPER_PID` | PID file (default sibling `helper.pid`) |
| `FM_ACP_AUTO_BOOTSTRAP` | `1`/`true` to allow AppleScript launch |
| `FM_ACP_AUTO_BOOTSTRAP_TIMEOUT_MS` | Wait for socket after launch (default `5000`) |

## Config options

| id | Purpose |
|---|---|
| `model` | `system` \| `pcc` |
| `backend` | `auto` \| `afm` \| `fm` (fm path uses helper → fm-wrap; PCC prefers helper) |
| `instructions` | System instructions |
| `use_case` | `general` \| `content-tagging` |
| `guardrails` | `default` \| `permissive-content-transformations` |
| `greedy` | boolean (system `fm`) |
| `bridge` | Prefer `afm bridge` for PCC |

## Environment

| Variable | Description |
|---|---|
| `AFM_BIN` / `AFM_BIN_PATH` | Path to `afm` |
| `FM_BIN` / `FM_BIN_PATH` | Path to `fm` (default `/usr/bin/fm`) |
| `AFM_EXTRA_ARGS` | Extra args for every `afm` invocation |
| `FM_EXTRA_ARGS` | Extra args for every `fm` invocation |
| `XDG_CONFIG_HOME` | Config root (`$XDG_CONFIG_HOME/fm-acp`) |
| `FM_ACP_SERVE_SOCK` | `fm serve --socket` path (default `~/.config/fm-acp/fm.sock`) |
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
- PCC from GUI-launched hosts needs Terminal-hosted `fm serve --socket` (recommended), a signed Foundation Lab bridge, or launching work inside Terminal.app. Spawning `fm respond` from a Node helper under Terminal still fails PCC. A PTY does **not** satisfy Apple's ancestry check.
- Keep logs on stderr only — stdout is ACP JSON-RPC.

## License

MIT
