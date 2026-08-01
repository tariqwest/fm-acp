# Phase 0 PCC matrix results

**Date:** 2026-08-01  
**Host:** macOS, Apple Foundation Models CLI (`/usr/bin/fm`)

## Summary decision

**Primary transport: Terminal-hosted `fm serve --socket`.**

External clients (curl/Node outside Terminal) can call PCC successfully when `fm serve --socket` is started under Terminal.app. Background/non-Terminal `fm serve` serves system but not PCC. Direct non-Terminal `fm respond --model pcc` fails.

Helper under Terminal is **not a viable PCC path** (child `fm respond` still denied). Prefer Terminal-hosted `fm serve --socket`. Direct Terminal `fm respond` works but is a bad multi-client server.

## Matrix

| # | Setup | Result |
|---|---|---|
| D | Direct `/usr/bin/fm respond --model pcc` from non-Terminal agent context | **FAIL** — `Private Cloud Compute is not available in this context. Please use the Terminal app.` |
| D' | `/usr/bin/fm available` non-Terminal | system available; PCC unavailable (Terminal message) |
| B | `fm serve --socket` backgrounded from non-Terminal | **socket up**; health: system available, pcc unavailable; system chat OK; pcc chat **503** same Terminal message |
| A | `fm serve --socket` started via `open -a Terminal` script | **PASS** — `fm available` in Terminal: system + PCC available; health both available; external curl pcc chat returned `term-serve-pcc-ok` |
| C | `fm-acp-terminal-helper` under Terminal (via `open -a Terminal`) | **FAIL for PCC** — helper listens, but child `fm respond --model pcc` stderr: Terminal ancestry error; empty text, exitCode 1. Node-spawned child does not inherit usable PCC context even when helper is under Terminal |
| C2 | Direct `fm respond --model pcc` inside Terminal via `open -a Terminal` | **PASS** — stdout `term-respond-pcc-ok` |
| E | `afm available` | afm installed at `/opt/homebrew/bin/afm` but CLI shape differs (`available` not a top-level subcommand as coded); needs separate adapter audit |

## Automation notes

- `osascript` `tell application "Terminal" to do script "..."` opened tabs but **did not execute** commands in this environment (no marker files).
- `open -a Terminal /path/to/script.sh` **did execute** and is the reliable auto-launch path for Phase 0.
- Implication for helper bootstrap: current AppleScript-only bootstrap is fragile; if any auto-start remains, prefer `open -a Terminal` script or document manual start only.

## Sample artifacts

### Non-Terminal serve health
```json
{"models":[{"available":true,"name":"system"},{"available":false,"reason":"Private Cloud Compute is not available in this context. Please use the Terminal app.","name":"pcc"}],"status":"fm serve is running"}
```

### Terminal serve health
```json
{"models":[{"name":"system","available":true},{"name":"pcc","available":true}],"status":"fm serve is running"}
```

### Terminal serve PCC completion (external client)
```json
{"model":"pcc","choices":[{"message":{"content":"term-serve-pcc-ok","role":"assistant"},"finish_reason":"stop"}]}
```

## Architecture implication

1. Ship fm-acp as a thin ACP client over `FM_ACP_SERVE_SOCK` → `fm serve --socket`.
2. Document operator step: start `fm serve --socket ~/.config/fm-acp/fm.sock` in Terminal.app (or via `open -a Terminal` wrapper).
3. Keep `afm` / direct `fm` as fallbacks for on-device when serve is down.
4. Quarantine/remove auto-bootstrap helper complexity; helper `fm respond` under Terminal did not return PCC text (exit 1). Do not invest in dual-launch AppleScript design.
5. `fm-wrap` / `node-pty` are not required for the validated PCC path.
6. Bootstrap note: `osascript do script` opened tabs but did not run commands here; `open -a Terminal script.sh` works.
