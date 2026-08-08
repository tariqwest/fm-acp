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
| E | `afm available` / bridge | Homebrew `afm` 0.1.0: **no** `available`/`bridge`. `model status` + `session respond` on-device **PASS**. Lab TestFlight 1.2.0 has `com.apple.developer.private-cloud-compute` but **no live Agent Bridge** (`~/.afm` missing). Upstream removed bridge/CLI from Lab main 2026-07-01. See `.agents/research/afm-lab-pcc-findings.md` |

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
5. `fm-access-pcc` / `node-pty` are not required for the validated PCC path.
6. Bootstrap note: `osascript do script` opened tabs but did not run commands here; `open -a Terminal script.sh` works.
7. **cua-driver automation (2026-08-01):** PASS — see section below.

## cua-driver Terminal automation (PASS)

**Driver:** `cua-driver 0.10.0` (`/Applications/CuaDriver.app`)
**Permissions at test time:** Accessibility ❌, Screen Recording ❌ (daemon). Typing path not required.

| ID | Method | Result |
|---|---|---|
| B | `fm available` from non-Terminal agent shell | system OK; PCC denied |
| A | `open -a Terminal /tmp/fm-acp-cua-serve.command` | PASS — health system+pcc |
| C0 urls | `launch_app` `urls:[file://…serve.command]` + new instance | FAIL — Terminal opens, script not executed (no marker/socket) |
| C0c urls path | `launch_app` `urls:[/tmp/…serve.command]` no new instance | FAIL — same |
| **C0d** | `launch_app` `bundle_id=com.apple.Terminal`, `additional_arguments:["/tmp/…serve.command"]`, `creates_new_application_instance:true` | **PASS** — socket up ~1–4s; health system+pcc; external curl PCC returned `cua-pcc-ok`; system chat OK; cleanly reproducible |
| C1 type_text | Not required after C0d PASS; AX not granted |

### Working recipe

```bash
# once: write executable serve launcher
cat > ~/.config/fm-acp/start-fm-serve.command <<'SH'
#!/bin/zsh
SOCK="${FM_ACP_SERVE_SOCK:-$HOME/.config/fm-acp/fm.sock}"
mkdir -p "$(dirname "$SOCK")"
exec /usr/bin/fm serve --socket "$SOCK"
SH
chmod +x ~/.config/fm-acp/start-fm-serve.command

# automate Terminal-hosted serve (PCC-capable):
cua-driver call launch_app '{
  "bundle_id": "com.apple.Terminal",
  "additional_arguments": ["/Users/tariqwest/.config/fm-acp/start-fm-serve.command"],
  "creates_new_application_instance": true
}' --compact
```

### Implication for fm-acp
Optional bootstrap can shell out to `cua-driver call launch_app` with Terminal + `additional_arguments` pointing at a checked-in/user serve script — no osascript, no helper `fm respond`, no AX typing. Prefer documenting this over integrating cua as a hard dependency until desired.
