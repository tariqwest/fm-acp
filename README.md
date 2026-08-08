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
- **Bun** ≥ 1.1 (preferred dev/runtime) and/or **Node.js** ≥ 20 (npm/npx + `FM_ACP_RUNTIME=node`)
- **Either** system `fm` at `/usr/bin/fm` **or** `afm` on `PATH`
- **`cua-driver`** (happy path for PCC auto-start). Installed automatically by `pnpm install` / first auto-serve; or:

```bash
curl -fsSL https://cua.ai/driver/install.sh | bash
```

Optional:

```bash
brew tap rudrankriyam/tap
brew install afm
```

## PCC (happy path): auto Terminal-hosted `fm serve`

PCC is available to **external clients** when `fm serve` itself runs under Terminal.app. **fm-acp does this by default**:

1. Ensure **`cua-driver`** (install via official script if missing)
2. Write `~/.config/fm-acp/start-fm-serve.command`
3. **`cua-driver call launch_app`** Terminal + `additional_arguments` (validated PCC path)
4. Fallback: **`open -a Terminal`** that launcher

```json
{
  "agent_servers": {
    "fm": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/fm-acp/bin/fm-acp.mjs"],
      "env": {
        "FM_ACP_SERVE_SOCK": "/Users/you/.config/fm-acp/fm.sock"
      }
    }
  }
}
```

Disable auto-start with `FM_ACP_AUTO_SERVE=0`. Manual serve still works:

```bash
# In Terminal.app:
mkdir -p ~/.config/fm-acp
fm serve --socket ~/.config/fm-acp/fm.sock
```

Validated: non-Terminal `fm serve` serves **system** only; Terminal-hosted `fm serve` serves **system + pcc**. `osascript do script` is **not** reliable. Helper `fm respond` under Terminal still fails PCC for the child.

> Note: There is no npm package that ships the `cua-driver` CLI. `@trycua/cua-driver` is an SDK only. fm-acp depends on the **system CLI/app** from [Cua’s installer](https://cua.ai/driver/install.sh) and treats it as a required runtime dependency for the happy path (`postinstall` + runtime ensure).

## Run

```bash
cd fm-acp
pnpm install        # package manager (lockfile)
bun run start       # preferred: Bun
# npm/npx Node path still works:
#   pnpm run fm-acp:node
#   node bin/fm-acp.mjs          # auto-picks Bun if on PATH, else Node+tsx
#   FM_ACP_RUNTIME=node node bin/fm-acp.mjs
```

Smoke:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | bun run start
# or: node bin/fm-acp.mjs
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

Auto-serve + cua-driver ensure run by default (no env required).

## Legacy Terminal helper

The old `fm-acp-terminal-helper` path (spawn `fm respond` under Terminal) is **not a reliable PCC path** and is kept only as a last-resort fallback. Prefer Terminal-hosted `fm serve` (default auto-start).

When fm-acp handles a PCC turn it tries, in order:

1. **`fm serve --socket`** (if healthy — preferred; auto-started via cua-driver by default)
2. **Foundation Lab Agent Bridge** (`~/.afm/bridge/connection.json` loopback HTTP, or `afm bridge` CLI if present)
3. **helper** / direct `fm respond` (legacy best-effort; usually fails PCC)

## Config options

| id | Purpose |
|---|---|
| `model` | `system` \| `pcc` |
| `backend` | `auto` \| `afm` \| `fm` (fm path uses helper → fm-access-pcc; PCC prefers helper) |
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
| `FM_ACP_AUTO_SERVE` | Default **on**. Set `0`/`false` to disable auto Terminal-hosted `fm serve` |
| `FM_ACP_ENSURE_CUA_DRIVER` | Default **on**. Set `0` to skip installing `cua-driver` when missing |
| `FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL` | `1` to skip `postinstall` cua-driver ensure |
| `CUA_DRIVER_INSTALL_URL` | Override installer URL (default `https://cua.ai/driver/install.sh`) |
| `CUA_DRIVER_BIN_DIR` | Install location for ensure (default `~/.local/bin`) |
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
pnpm install       # install deps (pnpm lockfile)
bun test           # preferred
bun run typecheck
bun run start
# Node parity:
pnpm run test:node
pnpm run fm-acp:node
```

`bin/fm-acp.mjs` keeps a **Node shebang** for `npx`/`npm` and prefers **Bun** when available (`FM_ACP_RUNTIME=bun|node` to force).


## Release

GitHub release and Homebrew tap updates are **coupled by default**:

```bash
# full release (tests → tarball → GitHub tag/release → homebrew-tap push)
bun run release

# opt out of one side when needed:
bun run release -- --github-only
bun run release -- --homebrew-only
bun run release -- --dry-run
bun run release -- --skip-tests
```

`release:homebrew` / `release:github` are thin aliases. Formula sources also live in `Formula/` and are published to `tariqwest/homebrew-tap`.

## Notes / limits

- On-device model is small (~3B); not a full coding agent replacement.
- PCC from GUI-launched hosts needs Terminal-hosted `fm serve --socket` (recommended). **Homebrew `afm` 0.1.0 is on-device only** (no `bridge`/`available`). Foundation Lab is signed with `com.apple.developer.private-cloud-compute` and historically hosted Agent Bridge (`connection.json` + bearer loopback); upstream removed that surface from Lab `main` on 2026-07-01 — see `.agents/research/afm-lab-pcc-findings.md`. Spawning `fm respond` from a Node helper under Terminal still fails PCC. A PTY does **not** satisfy Apple's ancestry check.
- Keep logs on stderr only — stdout is ACP JSON-RPC.

## Related projects

### Parent / protocol & platform

| Project | Relationship |
|---|---|
| [Agent Client Protocol](https://agentclientprotocol.com) | Parent protocol: stdio JSON-RPC that `fm-acp` implements as an agent server |
| Apple **Foundation Models** (`/usr/bin/fm`, Apple Intelligence / PCC) | Parent on-device + Private Cloud Compute platform this adapter targets |
| [`afm`](https://github.com/rudrankriyam/Foundation-Models-Framework-CLI) ([`rudrankriyam/tap`](https://github.com/rudrankriyam/homebrew-tap)) | Parent/upstream CLI fallback for Framework access (`session`, on-device) |
| [Cua Driver](https://cua.ai/driver/install.sh) | Runtime dependency for Terminal-hosted `fm serve` auto-start (PCC happy path) |

### Sibling ACP adapters (same family)

Same “ACP host ↔ stdio adapter ↔ backend CLI/API” shape as `fm-acp`:

| Project | Backend |
|---|---|
| [`oz-acp`](https://github.com/tariqwest/oz-acp) | Warp [`oz`](https://docs.warp.dev/reference/cli) |
| [`agy-acp`](https://github.com/tariqwest/agy-acp) | Google Antigravity `agy` (Rust) |
| [`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp) | Overlapping community ACP server for `agy` (Node/Bun; ToS risk on Google accounts) |

### Sibling / child Foundation Models stack

Projects in the same Apple FM surface area (library, HTTP, SDK). Prefer **`fm serve` + this adapter** for ACP hosts; the others cover REST, native bindings, or experimental PCC access:

| Project | Role |
|---|---|
| [`fm-server`](https://github.com/tariqwest/fm-server) | OpenAI-compatible HTTP server over system + PCC backends |
| [`fm-access-PCC`](https://github.com/tariqwest/fm-access-PCC) | TypeScript library + REST helpers for system + PCC |
| [`javascript-apple-fm-sdk`](https://github.com/tariqwest/javascript-apple-fm-sdk) | JS/TS bindings for on-device `SystemLanguageModel` |

`fm-acp` is the **ACP edge** of that stack (stdio), not a replacement for `fm-server`’s HTTP API.

### Overlapping gateways & CLI glue

| Project | Overlap |
|---|---|
| [`acp-to-api`](https://github.com/tariqwest/acp-to-api) | Inverse direction: OpenAI-compatible REST **in front of** local ACP agents (compose with `fm-acp` as the agent process) |
| [`prompt-to-api`](https://github.com/tariqwest/prompt-to-api) | Sibling REST gateway for single-prompt / print-mode CLIs (not full ACP sessions) |
| [`promptpipe`](https://github.com/tariqwest/promptpipe) | Unix-style prompt/stdin adapters for many CLIs, including `fm respond` and `oz` |
| [`agentbridge`](https://github.com/tariqwest/agentbridge) | Local MITM edge routing IDE/CLI AI traffic (broader routing, not FM-specific) |

### Inspiration

- ACP adapter layout and host wiring patterns from **`agy-acp` / `oz-acp`** (and the wider Antigravity ACP ecosystem).
- On-device session UX and CLI surface from **`afm`** / Foundation Models Framework CLI.
- PCC attribution constraints and Terminal-hosted serve path from local research in this repo (`.agents/research/`) and experiments around `fm-access-PCC` / helper spawn.

## License

MIT
