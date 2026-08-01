# afm / Foundation Lab PCC findings

**Date:** 2026-08-01  
**Host:** macOS 27.0 (26A5388g), Apple Silicon

## Verdict

Your mental model is **correct in design**, but **not operable today** with the installed Homebrew `afm` 0.1.0 + TestFlight Foundation Lab 1.2.0 combo.

| Path | PCC for editor-spawned fm-acp? | Notes |
|---|---|---|
| Terminal-hosted `fm serve --socket` | **Yes (validated)** | Primary; keep as default |
| Homebrew `afm` 0.1.0 alone | **No** | On-device session only; no `bridge` / `available` |
| Lab signed Agent Bridge + newer `afm bridge` | **Designed yes; not runnable here** | Entitlement present; host/CLI surface missing or not configured |
| Direct non-Terminal `fm` / background `fm serve` | **No** | Same Terminal ancestry rule |

## Evidence

### Foundation Lab.app (TestFlight 1.2.0)

- Bundle: `com.rudrankriyam.foundationlab`, Team `YQZQG7N4WG`
- Authority: TestFlight Beta Distribution
- **Entitlement confirmed:** `com.apple.developer.private-cloud-compute = true`
- Also: HealthKit; app-sandbox in source entitlements
- Binary embeds `AFMBridge*` / `AFMHTTPServer` / `PrivateCloudComputeLanguageModel` symbols
- **No live bridge:** no `~/.afm`, no `connection.json`, no Lab TCP listener while app running
- Container `com.rudrankriyam.foundationlab` exists but Data is TCC-restricted from this agent context
- Swift type names for `AgentBridgeController` were **not** found via `strings` (only `AFMBridge*` / `AFMHTTPServer`); UI host may be incomplete in this build or stripped from string tables

### Homebrew `afm` 0.1.0 (`tariqwest/allbrew` → upstream 0.1.0 universal)

Real surface:

- `model status|languages|use-cases|guardrails`
- `session respond|stream|chat`
- `tag`, `schema`, `tool`, `transcript`, `feedback`
- **Not present:** `bridge`, `available`, `serve`, `quota-usage`

Empirical:

```text
afm model status --output json
→ isAvailable=true (system / on-device)

afm session respond --prompt "Reply with exactly: afm-system-ok"
→ success (on-device)

afm bridge status
→ Error: unexpected arguments 'bridge', 'status'

afm available
→ Error: Unexpected argument 'available'
```

### Upstream Lab design (source recovered from pre-removal commit `c47c161`)

Commit **`a040c8d` (2026-07-01): “Remove local AFM bridge and CLI surfaces”** deleted `Tools/AFMCLI`, `Packages/AFMServer`, and `Foundation Lab/AgentBridge` from `main`. Current Lab README still points at the archived standalone CLI repo and does not document Agent Bridge.

Before removal (PR [#177](https://github.com/rudrankriyam/Foundation-Models-Framework-Lab/pull/177)):

1. **Signed host = Foundation Lab.app** with managed `com.apple.developer.private-cloud-compute`
2. User enables **Agent Bridge** in Settings, picks a private base folder (recommended `~/.afm`)
3. Lab starts **authenticated loopback HTTP** (`AFMHTTPServer`), publishes `bridge/connection.json` (mode-safe, bearer redacted in logs)
4. Headless **`afm bridge`** client (no TTY, no entitlement inheritance):
   - `prepare` — create `~/.afm` / bridge dir (0700)
   - `ensure` / `launch` — `open -gj` Lab, wait for health
   - `status` / `models` / `chat --model system|pcc`
5. Descriptor default: `~/.afm/bridge/connection.json`
6. Client uses **Bearer** + **loopback TCP only** (unix socket supported in endpoint enum but client rejects non-TCP)
7. OpenAI-shaped `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`
8. Model catalog advertises `system` when `SystemLanguageModel` available; `pcc` only if OS 27 + entitlement granted + `PrivateCloudComputeLanguageModel().isAvailable`
9. PR verification claimed live `chat --model pcc` through the signed host

Bench docs (FoundationModelsBench) independently state: **SwiftPM / unsigned executables must not claim PCC**; use a signed app with the managed entitlement.

### fm-acp mismatch (before this research alignment)

`src/backends/afm.ts` assumed:

- `afm available --output json`
- `afm bridge chat|status`

Those match the **post-0.1.0 Lab CLI**, not Homebrew 0.1.0. That is why probes failed with `Unexpected argument 'available'`.

## Operator flow (when Lab bridge is actually shipping)

```bash
# 1) Build/install bridge-capable afm (not Homebrew 0.1.0 frozen standalone)
#    historically: swift build -c release --product afm  (Lab tree pre-a040c8d)
# 2) Install signed Foundation Lab with PCC entitlement (TestFlight or own signing)
# 3) Once:
mkdir -p ~/.afm && chmod 700 ~/.afm
afm bridge prepare
# In Foundation Lab → Settings → Agent Bridge:
#   Choose base folder ~/.afm, Enable local agent bridge
afm bridge ensure --app "/Applications/Foundation Lab.app"
afm bridge models
afm bridge chat --model pcc --prompt "ping"
```

fm-acp can then either shell out to `afm bridge …` or speak the descriptor HTTP protocol directly (preferred: fewer CLI version pins).

## Comparison to Terminal `fm serve`

| | Terminal `fm serve` | Lab Agent Bridge |
|---|---|---|
| PCC authority | Apple’s Terminal ancestry exception for `fm` | App managed entitlement |
| Multi-client | Yes (UDS/HTTP) | Yes (loopback HTTP + bearer) |
| Auto-start | cua-driver / `open -a Terminal` validated | `open -gj` Lab + ensure (documented upstream; not validated here) |
| Install surface today | `/usr/bin/fm` always present | Needs Lab build **with** Agent Bridge host + matching CLI |
| fm-acp status | **Primary, validated** | **Secondary candidate after host+CLI restored** |

## Recommendations for fm-acp

1. Keep **Terminal `fm serve --socket`** as the only default PCC promise.
2. Treat **afm session** as on-device fallback (`model status` / `session stream|chat`).
3. Implement optional **Lab bridge HTTP client** against `connection.json` (and/or `afm bridge` when present); do not invent `available`/`bridge` on 0.1.0.
4. Config `bridge`: means “prefer Lab bridge when descriptor/CLI healthy,” not “claim PCC via brew afm.”
5. Do not invest in helper-as-PCC; Lab bridge is the correct entitlement-based alternative if upstream re-ships it.
6. Track Lab `main`: bridge was **removed** 2026-07-01 — confirm before documenting as a supported install path for end users.

## Artifacts

- Source snapshots: `.agents/research/afm-bridge-sources/` (from Lab commit `c47c161`)
- This note: `.agents/research/afm-lab-pcc-findings.md`

## Relocation check (2026-08-01)

Searched public GitHub under `rudrankriyam` and org `rryam` for a moved Agent Bridge / AFMServer host.

**Result: not relocated — deleted from public Lab tree.**

- Lab commits `a040c8d` / `703f498` (2026-07-01): *Remove local AFM bridge and CLI surfaces* — **146 deletions, 0 renames, 0 adds**. Removed `Foundation Lab/AgentBridge/*`, entire `Packages/AFMServer`, AFM CLI workflows/scripts.
- `gh search code` for `AFMBridgeClient`, `AgentBridgeController`, `afm bridge ensure` under those owners: **no hits**.
- No new repo named like agent-bridge / afm-server / afm-bridge.

**Related public projects (not a drop-in bridge host):**

| Repo | Role vs bridge/PCC |
|---|---|
| `rudrankriyam/Foundation-Models-Framework-Lab` | Workbench remains; in-app PCC labs + entitlement; Agent Bridge host **gone** from `main` |
| `rudrankriyam/Foundation-Models-Framework-CLI` | Archived; Homebrew still ships frozen **afm 0.1.0** (no bridge) |
| `rryam/FoundationModelsKit` | Shared kit; includes `PrivateCloudComputeEntitlementChecker` only — **no** HTTP bridge server |
| `rudrankriyam/FoundationModelsBench` | Evaluation suite; PCC via **signed device runner app**, not multi-client bridge |
| `rudrankriyam/FoundationModelsAgent` | Agent harness/`AgentSession`; can target PCC when process entitled — **not** Lab connection.json host |
| `rudrankriyam/homebrew-tap` | `Formula/afm.rb` still points at CLI 0.1.0 universal artifact |

Implication for fm-acp: keep Terminal `fm serve` as primary PCC; Lab bridge client stays speculative until upstream re-publishes a signed host + descriptor protocol (publicly or via TestFlight-only bits not in git).

