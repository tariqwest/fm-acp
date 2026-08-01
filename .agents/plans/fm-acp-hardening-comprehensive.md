# fm-acp Comprehensive Hardening & Transport Redesign Plan

**Status:** Approved — implementation in progress  
**Date:** 2026-08-01  
**Project:** `/Users/tariqwest/Developer/fm-acp`  
**Concise companion plan (Warp Drive):** `b57149e3-ca59-41a5-8b9f-67f9cdf0f35c`  
**Phase 0 decision:** Terminal-hosted `fm serve --socket` is the only validated multi-client PCC path. Helper under Terminal still fails PCC for child `fm respond`. Details: `./.agents/plans/pcc-matrix-results.md`.
**Related prior plans:**
- Terminal.app helper: `f38636d0-2604-4b2a-aec5-a7f8a5b6a23f` (implemented; now under redesign review)
- Original project plan: `d785b48d-f5a6-4c85-b343-e407f5b0aa94`

---

## 1. Executive summary

`fm-acp` is a working ACP stdio adapter for Apple Foundation Models. It already supports:

- ACP host integration over stdio
- dual backends (`afm` preferred, system `/usr/bin/fm` fallback)
- session persistence + config options
- a Terminal.app helper intended to unlock PCC
- 44 unit tests and clean typecheck

It is **not yet safe or releasable**. A full architecture/security/ACP/prior-art review found:

1. **Release-blocking security defects** (path traversal via session IDs, world-readable transcripts, unauthenticated helper, dual helper launch).
2. **Correctness defects** (concurrent prompt races, fire-and-forget stream callbacks, fallback after partial output, weak cancel escalation, corrupt-store wipe).
3. **ACP conformance gaps** (silent unknown-session creation, over-advertised image support, incomplete lifecycle, ignored MCP/cwd semantics).
4. **Likely wrong PCC architecture** relative to current macOS 27 guidance and prior art: Apple ships `fm serve --socket`; community tools foreground that server in Terminal.app rather than auto-spawning Node helpers that then call `fm respond`.
5. **Package/release blockers** (`link:../fm-wrap`, runtime `tsx`, install-time `npx node-gyp`, no CI/contract tests).

**Recommended direction:** harden security and session semantics immediately; validate PCC with a Terminal.app matrix; then prefer a thin ACP client over user-started, Terminal-foregrounded `fm serve --socket`, collapsing the helper/`fm-wrap`/node-pty stack unless Phase 0 proves they uniquely enable PCC.

---

## 2. Review method and confidence

### What was inspected
- Full local tree: `src/**`, `bin/**`, `scripts/**`, tests, `package.json`, lockfile, `tsconfig`, `README.md`, `AGENTS.md`
- Installed `@agentclientprotocol/sdk@1.3.0` contracts
- Installed `/usr/bin/fm` (`available`, `serve --help`, command surface)
- `pnpm pack --dry-run` / existing test+typecheck surface (44 tests green)
- Prior art: `fm-proxy`, `afm`, `fm-server`/`fm-wrap` stack, mature ACP adapters (`agy-acp`, `openclaw/acpx`, `gemini-acp`)
- Architecture/security child audit with live path-traversal and permission probes

### Confidence levels used in this plan
| Label | Meaning |
|---|---|
| **Confirmed** | Reproduced by code inspection and/or local probe |
| **Strongly evidenced** | Clear code path + external docs/prior art align |
| **Plausible risk** | Threat-model dependent or needs live Terminal/PCC proof |
| **Future enhancement** | Valuable, not blocking correctness/security |

### Gaps / caveats
- Three specialist child runs (ACP/capabilities, tests/release, prior-art) completed research but errored before delivering final handoffs; those areas are covered from parent research + architecture/security handoff.
- No destructive write of traversed paths was performed.
- Live PCC success under Terminal.app was **not** fully matrix-validated in this review; Phase 0 is mandatory before deleting/keeping transport pieces.
- Repo currently has **no `.git`**, so VCS-based release history is unavailable.

---

## 3. Current architecture (as implemented)

```text
ACP host (Zed / VS Code / Devin / …)
    │ JSON-RPC NDJSON over stdio
    ▼
bin/fm-acp.mjs → tsx src/index.ts → FmAcpAgent (src/adapter.ts)
    │
    ├─ session store: ~/.config/fm-acp/sessions.json + transcripts/
    ├─ availability probe: afm available | fm available
    │
    └─ runPromptTurn (src/backends/resolve.ts)
           │
           ├─ model=system:
           │     afm session stream/respond  →  fm respond
           │
           └─ model=pcc:
                 helper socket  →  afm bridge  →  fm-wrap/PTY fm respond
                        │
                        ▼
              fm-acp-terminal-helper (Terminal.app descendant)
                        │
                        ▼
                 /usr/bin/fm respond --model pcc
```

### Important modules
| Area | Files |
|---|---|
| ACP wiring | `src/index.ts`, `src/adapter.ts`, `src/types.ts`, `src/config-options.ts`, `src/map.ts` |
| Persistence | `src/session-store.ts` |
| Process helpers | `src/process.ts`, `src/shell-words.ts` |
| Backends | `src/backends/resolve.ts`, `afm.ts`, `fm.ts`, `helper.ts` |
| Helper infra | `src/helper-protocol.ts`, `helper-socket.ts`, `helper-bootstrap.ts`, `bin/fm-acp-terminal-helper.mjs` |
| Packaging | `bin/fm-acp.mjs`, `scripts/rebuild-node-pty.mjs`, `package.json` |

### What works today
- Initialize + config options + basic prompt streaming path
- Backend auto-selection afm/fm
- Transcript/history mapping helpers
- Helper protocol unit tests with fakes
- Typecheck and 44 pure/unit tests pass

### What is fragile today
- Three divergent CLI paths + helper + optional PTY
- PCC attribution assumptions may be outdated vs `fm serve`
- Security boundary around helper + session files is weak
- Session concurrency and stream ordering are not production-grade
- Package cannot be installed from npm as declared

---

## 4. Threat model (confirmed framing)

### Trust boundaries
1. **ACP client** controls: session IDs, cwd, prompts, image refs, config updates, cancel, concurrency.
2. **Helper Unix socket** is a local privileged/confidentiality boundary: it can lend Terminal ancestry/PCC access and run `fm` with user authority, reading images and writing transcripts.
3. **Persisted state** (`sessions.json`, transcripts, helper logs) contains prompts, instructions, responses, cwd, and paths.
4. **Install/runtime supply chain**: PATH binary resolution, `npx --yes node-gyp`, linked local packages.

### Adversaries / failure sources
- Hostile or buggy ACP host / plugin
- Same-UID local processes (other apps, malware, compromised tools)
- Other local users on multi-user Macs (world-readable state)
- Crash/restart races (locks, half-written state)
- Backend CLI drift / error envelopes

### Security goals
- No arbitrary file write/delete via session IDs or helper paths
- No silent world-readable prompt history
- No unauthenticated confused-deputy access to PCC/helper
- Deterministic cancel and no cross-turn transcript corruption
- Fail closed on corrupt persistence

---

## 5. Findings by severity

### P0
None confirmed as remote RCE / cross-user privilege escalation under current same-machine model.

### P1 — confirmed defects (fix before feature work)

#### P1.1 Session ID path traversal / arbitrary `.json` write+delete
**Evidence**
- `adapter.ts` prompt path silently creates a session for unknown IDs and assigns `transcriptPathFor(sessionId)`
- `session-store.ts` `transcriptPathFor` joins `` `${sessionId}.json` `` with no validation
- `delete` unlinks that path
- Read-only probe: `../../../../tmp/victim` escapes transcript root
- `fm` backend can receive `--save-transcript` pointing at that path

**Impact:** arbitrary filesystem write (via fm transcript) and delete of `*.json`-shaped paths as the user.

**Fix**
- Validate all externally supplied session IDs (UUID form) on new/load/resume/delete/config/prompt/cancel
- Resolve + `realpath`/canonicalize transcript paths and require prefix under `transcriptsDir`
- Never create sessions from unknown prompt IDs; return protocol error
- Tests: traversal on prompt + delete + save-transcript path construction

#### P1.2 World-readable sensitive state
**Evidence**
- `mkdir`/`writeFile` use default modes
- Live metadata: `~/.config/fm-acp` and `transcripts/` `0755`; `sessions.json` and transcripts `0644` under umask `022`
- Contents include prompts, responses, instructions, cwd, paths

**Fix**
- Dirs `0700`, files/temp/log/pid/socket `0600`
- Helper `umask(0o077)` before create
- Migration pass to chmod existing tree
- Permission tests

#### P1.3 Dual helper launch + unconditional socket unlink
**Evidence**
- `helper-bootstrap.ts` `buildAppleScript` emits both:
  - Terminal `do script "exec …"`
  - independent `do shell script … nohup … &`
- Helper daemon unlinks any existing socket on startup

**Impact:** two helpers; non-Terminal ancestry instance can win the socket; live helper DoS/takeover; PCC attribution defeated.

**Fix**
- Exactly one launch path (Terminal `do script` only, properly quoted)
- Exclusive singleton lock (pid/lockfile or `flock`)
- Probe + protocol handshake before removing socket
- Second instance must refuse to bind
- Integration test: one spawn; second refuses

#### P1.4 Helper is an unauthenticated same-UID confused deputy
**Evidence**
- Socket mode `0600` only excludes other UIDs after bind
- Requests only shallowly check `op`
- Accepts arbitrary transcript/image paths and model options
- `started` events include full argv (prompts/instructions)
- Client readiness is connect-only, not authenticated/versioned identity
- `shutdown` only closes one connection

**Fix**
- Protocol version + identity handshake
- Strict schema validation (zod)
- Path policy: transcripts only under managed dir; images under allowlisted roots
- Avoid echoing secrets/prompts in events
- Real process-wide shutdown
- Prefer macOS peer credential checks; at minimum refuse non-owner sockets and verify socket type/mode/owner before use
- Adversarial fake-server/client tests

### P1 — strongly evidenced product risk

#### P1.5 PCC architecture mismatch (needs Phase 0 proof)
**Evidence**
- Current non-Terminal context: `fm available` → system ok, PCC “use the Terminal app”
- `/usr/bin/fm serve --socket` is first-class and recommended for local bindings
- Prior art (`fm-proxy` and related) uses foreground Terminal-hosted `fm serve`, with proxy/client separate
- Current design auto-bootstraps a Node daemon then spawns `fm respond`

**Implication:** helper complexity may be both insecure and unnecessary—or necessary only in a narrower form. Do not double-down until Terminal matrix is run.

### P2 — confirmed correctness defects

#### P2.1 Concurrent prompts / cancel ownership
- Adapter overwrites `session.activeAbort` without rejecting/queuing overlapping turns
- Helper `activeChild` is per-connection, not daemon-global
- Parallel turns can corrupt history/transcripts; cancel hits only latest controller

**Fix:** per-session FIFO or explicit busy error; daemon global semaphore; turn-scoped cancel IDs

#### P2.2 Cancel / timeout escalation broken
- `process.ts` uses `child.killed` (signal sent ≠ exited), so SIGKILL often never runs
- Timeout only SIGTERM, no timeout-specific reject, can hang
- No process-group / descendant cleanup
- Helper disconnect only SIGTERM

**Fix:** track `exit`/`close`; grace then SIGKILL; reject with cancel/timeout; optional `detached`+group kill where safe

#### P2.3 Stream callback ordering and fallback-after-partial-output
- `runCommand` fire-and-forgets `onStdout` promises
- Helper client fire-and-forgets `onText`
- `resolve.ts` can try next backend after a backend already streamed chunks then failed → mixed/duplicated user-visible output

**Fix:** serialize/await callback chain; mark “output emitted”; fallback only before first external chunk; drain before settle

#### P2.4 Helper success-on-nonzero-with-stdout + missing normalization
- Helper backend treats nonzero exit as success if any text exists
- Daemon streams raw stdout; normalization exists mainly on direct fm path
- JSON error envelopes can be persisted as assistant success

**Fix:** nonzero always error unless explicitly defined otherwise; normalize once; bounded stderr in errors

#### P2.5 Persistence fail-open and stale locks
- Any non-ENOENT load error → empty store → next save can wipe all sessions
- Lock file has no stale recovery (crash → 10s timeouts forever until manual delete)
- Temp name is PID-only (collisions under concurrent writers in one process)
- No retention/byte caps; `MAX_SESSIONS` only bounds in-memory map

**Fix:** fail closed + quarantine corrupt file; PID/timestamp or OS lock stale recovery; unique temps; quotas

#### P2.6 AppleScript / path injection and weak quoting
- Only `"` escaped; paths interpolated into shell-ish strings
- Spaces/metacharacters in install paths can break or inject

**Fix:** proper AppleScript string + POSIX shell quoting, or argv-safe launch; property tests

#### P2.7 Unbounded buffers / DoS
- Unbounded request line buffers, stdout buffers, history, seenKeys, logs
- No backpressure

**Fix:** hard limits on line size, output size, history turns/bytes, concurrent connections

### P3 — risks / hygiene
- Signal termination mapped to exit code 0
- Availability init race (fire-and-forget + uncoordinated `ensureAvailability`)
- Image extraction absolute-path-only; capability advertises general images
- Binary resolution existence-only (not executable/owner/type)
- Install hook `npx --yes node-gyp` supply chain
- `tsconfig` includes `.mjs` without `allowJs`/`checkJs` → helper daemon not typechecked
- No CI, lint, coverage, pack-install smoke, ACP contract tests

### ACP / capability gaps (confirmed or strongly evidenced)
| Area | Current behavior | Expected / desired |
|---|---|---|
| Unknown `session/prompt` ID | silently creates session | error unknown session |
| `session/load` | may swallow transcript errors | replay full history or fail closed |
| `session/list` | ignores filters/pagination/update timestamps | honor or document subset |
| `session/close` | missing | implement or advertise absence |
| Images | advertised; only absolute local paths | data/MIME or temp materialization; advertise honestly |
| MCP servers / additionalDirectories | ignored | reject or no-op with clear docs |
| `cwd` | stored, not passed to backends | pass through where meaningful |
| Config updates | partial | return complete option list (SDK expectation) |
| Concurrent prompts | racy | serialize or busy |
| Cancel mid-turn | incomplete persistence | consistent history + stopReason |

### Release / packaging blockers (confirmed)
- `fm-wrap: "link:../fm-wrap"` unpublishable
- Runtime executes TS via production `tsx`
- `node-pty` direct dep + postinstall rebuild via networky `npx`
- Open caret ranges on pre-1.0 / fast-moving deps
- No compiled dist strategy
- Tests omit adapter/store/daemon/contract/pack surfaces

---

## 6. Prior art and architectural recommendation

### Relevant prior art patterns
| Source | Useful pattern |
|---|---|
| Apple `fm serve --socket` | System-signed local server; OpenAI-compatible chat completions; recommended UDS mode |
| `fm-proxy` / similar | Thin proxy/client; server stays foregrounded in Terminal for PCC |
| Mature ACP adapters | Per-session prompt FIFO; ordered update promise chain; fake ACP peer tests |
| `afm` | Structured NDJSON, bridge status honesty, availability runnable split |
| Solid TS CLIs | Exact pins, contract tests as upgrade gates, hermetic subprocess fixtures |

### Recommended end-state architecture

```text
User starts in Terminal.app (once per login/session):
  fm serve --socket ~/.config/fm-acp/fm.sock

ACP host
  └─ fm-acp (stdio)
        ├─ session store (0700/0600, fail-closed)
        └─ primary backend: HTTP/1.1 over Unix socket → fm serve
              models: system | pcc
              streaming chat completions
              usage + typed errors

Fallbacks (if serve unavailable):
  afm session / bridge
  direct /usr/bin/fm respond

Helper / fm-wrap / node-pty:
  keep only if Phase 0 shows unique PCC value; otherwise remove or quarantine
```

### Why this is better
- Uses Apple’s supported local server surface instead of re-implementing process/PTY mythology
- Shrinks privileged custom daemon surface area
- One streaming protocol to normalize (SSE/chunked chat completions) instead of three CLI dialects
- Clear operator model: “start fm serve in Terminal, point ACP host at fm-acp”
- Aligns with community practice already solving PCC attribution

### What to do with the existing helper
Until Phase 0 completes:
1. Treat auto-bootstrap as **unsafe defaults off** (already mostly true) and document risk.
2. If retained at all, fix singleton/auth/path policy first.
3. If `fm serve --socket` from Terminal fully enables PCC for external clients, **delete** auto-bootstrap and most helper code.
4. If only a Terminal-ancestry `fm respond` works, keep a **minimal** single-instance helper with no dual-launch and no broad path authority.

---

## 7. Phase plan

### Phase 0 — PCC validation gate (before irreversible transport deletion)
**Goal:** evidence for primary transport choice.

Matrix (real Terminal.app, not iTerm/Warp pane if ancestry matters):

| # | Setup | Client | Expected measurement |
|---|---|---|---|
| A | Foreground `fm serve --socket` in Terminal.app | Node/curl client outside Terminal calling `/v1/models` + chat `model=pcc` | Does PCC work? |
| B | `fm serve` started by Node/background | same | Does PCC fail? |
| C | Current helper → `fm respond --model pcc` under Terminal | fm-acp prompt | Does PCC work? |
| D | Direct `fm respond --model pcc` from non-Terminal | CLI | Baseline failure |
| E | `afm bridge` path if installed | fm-acp | Status/errors |

Deliverable: short results note in `.agents/plans/pcc-matrix-results.md` and update this plan’s open decision.

**Decision rule**
- If A works for system+PCC → primary = serve-socket; helper becomes optional/removed.
- If only C works → primary = hardened helper; serve-socket still useful for system/on-device.
- If neither works reliably → document honest limitation; system-only default; PCC opt-in with clear ops docs.

### Phase 1 — P1 security & correctness (do first, regardless of transport)
Priority order inside phase:

1. **Session ID + path containment**
   - UUID validation helper shared by adapter + store
   - canonical transcript path checks
   - reject unknown prompt session IDs
   - delete only contained paths
2. **Permissions migration**
   - ensureDir/file helpers with modes
   - chmod existing state on startup
   - helper umask + socket mode
3. **Helper singleton + bootstrap repair** (if helper remains even temporarily)
   - one AppleScript launch
   - lock + handshake before unlink
   - refuse second instance
4. **Helper trust boundary hardening**
5. **Concurrency + cancel escalation**
6. **Stream callback serialization + no fallback-after-emit + error normalization**

Exit criteria:
- Traversal tests pass
- State tree is 0700/0600
- Two overlapping prompts cannot corrupt one session
- Cancel reliably stops child within grace+kill window
- Nonzero fm/helper exits never become successful assistant text

### Phase 2 — ACP conformance & capability honesty
1. Capability advertisement audit against SDK 1.3.0
2. Image pipeline:
   - accept ACP image data blocks by writing secure temp files under managed dir, or
   - stop advertising image support until implemented
3. Lifecycle:
   - load fail-closed
   - list metadata timestamps
   - close semantics
   - unknown session errors everywhere
4. Pass `cwd` into backend spawns
5. Single-flight availability probe; honest runnable flags
6. Persistence fail-closed, stale lock recovery, retention caps

Exit criteria:
- Fake ACP stdio contract test: initialize → new → prompt → load replay → cancel → delete
- No capability bit set for unimplemented features
- Corrupt `sessions.json` does not wipe data on next save

### Phase 3 — Transport simplification
1. Implement `src/backends/fm-serve.ts` (name flexible):
   - connect to UDS
   - `GET /health`, `GET /v1/models`
   - `POST /v1/chat/completions` streaming
   - map chunks → ACP `agent_message_chunk`
   - map usage/errors
2. Config/env:
   - `FM_ACP_SERVE_SOCK` (default under `~/.config/fm-acp/fm.sock`)
   - optional model list cache TTL
3. Resolver order (proposed default after Phase 0 success of A):
   1. fm serve socket if healthy
   2. afm
   3. direct fm
   4. helper only if still required for PCC
4. Remove or optionalize:
   - `link:../fm-wrap`
   - `node-pty` + postinstall rebuild
   - auto-bootstrap helper path
5. Docs rewrite: operator starts `fm serve --socket …` in Terminal.app

Exit criteria:
- system streaming works via serve-socket without CLI scraping
- PCC either works via documented Terminal serve path or is honestly marked non-runnable
- package no longer requires sibling `fm-wrap` checkout

### Phase 4 — Release engineering & test infrastructure
1. Packaging
   - pin dependency versions
   - decide distribute strategy: compile to `dist/` **or** keep tsx but make it explicit and remove unpublishable deps
   - `prepack` includes pack-install smoke in temp dir
2. Tests to add (minimum)
   - path traversal / UUID rejection
   - permissions
   - helper singleton + auth handshake
   - concurrent prompts
   - partial-stream no-fallback
   - callback ordering + rejection propagation
   - cancel escalation with SIGTERM-ignoring child fixture
   - corrupt store quarantine
   - stale lock recovery
   - fake ACP stdio contract
   - fm-serve client against mock HTTP-over-UDS server
   - `pnpm pack` + install smoke
3. CI
   - macOS GitHub Actions: install, test, typecheck, pack dry-run
   - optional manual/workflow_dispatch PCC job
4. Quality gates
   - lint/format (lightweight)
   - typecheck includes helper JS via allowJs/checkJs or rewrite helper to TS build

Exit criteria:
- clean install from packed tarball on a machine without `../fm-wrap`
- CI green on PR
- security regressions covered by tests

---

## 8. Detailed implementation notes (by area)

### 8.1 Session identity and filesystem policy
```text
validSessionId := UUID v4/v7 string (strict regex)
transcriptPath := realpath(join(transcriptsDir, id + ".json"))
require transcriptPath == join(realpath(transcriptsDir), id + ".json")
```
- Apply on every entrypoint that accepts `sessionId`
- Store should not trust caller-provided absolute `transcriptPath` from disk without re-check
- Helper must ignore client-supplied transcript paths outside allowlist (or ignore client path entirely and receive only sessionId)

### 8.2 Permissions helpers
Centralize:
- `ensurePrivateDir(path)`
- `writePrivateFile(path, data)`
- `migrateTreePermissions(root)`
Call from store init, helper startup, serve-sock client setup.

### 8.3 Prompt concurrency
Preferred UX for hosts:
- **Per-session queue** (FIFO) with optional timeout, **or**
- Immediate busy error (`-32000` / explicit stopReason) if a turn is active

Global:
- limit concurrent backend runs (serve client can multiplex; CLI/helper should not stampede)

### 8.4 Stream update queue
Pattern used by mature adapters:
```ts
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn, fn); return chain; };
// on chunk: await enqueue(() => emit(...))
// before finish: await chain
```
Propagate failures; never void floating promises from user-visible emits.

### 8.5 Fallback policy
```text
state = idle
on first successful external emit: state = committed
on error:
  if state == idle → try next backend
  if state == committed → fail turn (do not switch backends)
```

### 8.6 fm serve client sketch
- Use Node `http` request over `socketPath` (no third-party dep required)
- Headers: `Content-Type: application/json`, `Accept: text/event-stream` when streaming
- Parse SSE `data:` lines or chunked JSON deltas depending on actual `fm serve` behavior (verify in Phase 0/3 against live server; do not guess schema in final code without capturing fixtures)
- Map:
  - assistant text deltas → ACP chunks
  - final usage → optional thought/metadata or log
  - HTTP 4xx/5xx → FmAcpError with body message

### 8.7 Error normalization
Single module for:
- JSON error envelopes from fm/afm
- HTTP error bodies from serve
- nonzero exit + stderr
- PCC “use Terminal app” → actionable operator guidance

### 8.8 Package strategy options
| Option | Pros | Cons |
|---|---|---|
| A. Ship TS + tsx | simple | heavier runtime dep; slower start |
| B. Compile to dist JS | cleaner publish | build step |
| C. Single bundled bin (esbuild) | easy install | harder debug |

Recommendation: **B or C** for publish; keep tsx for dev. Remove native deps if serve-socket path wins.

---

## 9. Testing strategy

### Current gap
Tests are mostly pure builders/parsers + fake helper client. Missing adapter lifecycle, store failure modes, daemon process behavior, concurrency, and pack/install.

### Target layers
1. **Unit** — validators, path canonicalization, permissions helpers, SSE parser, error normalizer, config options
2. **Component** — SessionStore with temp dirs; adapter with mocked backends; helper protocol with fake sockets
3. **Process integration** — helper singleton; cancel escalation child fixtures; mock `fm serve` UDS server
4. **ACP contract** — stdio JSON-RPC script driving real `FmAcpAgent` with fake backend
5. **Pack smoke** — `pnpm pack` → install in temp → run `--help`/initialize
6. **Manual PCC** — Phase 0 matrix checklist

### Minimum new test files (suggested)
- `src/session-id.test.ts`
- `src/session-store.test.ts`
- `src/adapter.concurrency.test.ts`
- `src/adapter.contract.test.ts`
- `src/process.cancel.test.ts`
- `src/backends/resolve.fallback.test.ts`
- `src/backends/fm-serve.test.ts`
- `src/helper-daemon.integration.test.ts` (optional heavier)
- `scripts/pack-smoke.mjs`

---

## 10. Documentation changes
- README operator flow for `fm serve --socket`
- Honest PCC prerequisites (Terminal ancestry; no claim that PTY alone works)
- Security notes: state dir permissions, helper trust assumptions
- Capability matrix: what ACP features are real
- Migration notes if helper env vars change or are removed
- AGENTS.md architecture diagram update after Phase 3

---

## 11. Non-goals (this pass)
- Full MCP tool bridging into Foundation Models tools
- Agentic shell/command execution loop
- Claiming unsigned PCC from GUI-spawned processes without Terminal/serve
- Windows/Linux support
- Replacing `fm-server` OpenAI HTTP product surface outside ACP
- Large refactors unrelated to security/correctness/transport

---

## 12. Suggested implementation todo list (for after approval)

> Do not create the live Warp TODO list until this plan is approved. This is the intended breakdown.

### Phase 0
1. Run Terminal.app PCC matrix A–E and record results
2. Update plan open decision + choose primary transport

### Phase 1
3. Session ID validation + path canonicalization + unknown session errors
4. Private permissions + migration
5. Helper singleton/bootstrap fix (or feature-flag disable auto-bootstrap hard)
6. Helper auth/schema/path allowlist/shutdown semantics
7. Per-session prompt mutex + turn-scoped cancel
8. Process cancel/timeout escalation + group kill where safe
9. Stream callback serialization
10. Fallback-after-emit prevention
11. Helper/fm nonzero exit + normalization fixes
12. Persistence fail-closed + stale lock recovery + unique temps + basic quotas
13. Tests for all Phase 1 items

### Phase 2
14. Capability advertisement honesty
15. Image data support or remove capability bit
16. Load/list/close lifecycle hardening
17. cwd pass-through; MCP/additionalDirectories policy
18. Single-flight availability probe
19. ACP contract tests

### Phase 3
20. fm serve UDS client backend
21. Resolver reordering + env/docs
22. Remove or optionalize fm-wrap/node-pty/helper based on Phase 0
23. Mock serve integration tests

### Phase 4
24. Publishable package (pins, no link dep, no network postinstall)
25. CI workflow
26. Pack/install smoke
27. Final README/AGENTS pass
28. Manual host smoke (Zed or printf JSON-RPC)

---

## 13. Success criteria
- [ ] No sessionId path traversal; unknown IDs rejected
- [ ] State/helper files not world-readable by default; migration applied
- [ ] One supported, documented PCC path validated in Terminal.app
- [ ] Concurrent prompts cannot corrupt session history/transcripts
- [ ] Cancel stops work reliably; timeouts error clearly
- [ ] No backend fallback after user-visible streamed output
- [ ] ACP load/prompt/cancel/config match SDK expectations with honest capabilities
- [ ] Corrupt store cannot silently wipe sessions
- [ ] `pnpm pack` install works without sibling checkouts or network rebuilds
- [ ] CI runs test + typecheck + pack dry-run
- [ ] Existing green unit suite remains green; new regression tests cover P1/P2 fixes

---

## 14. Open decisions
1. **Primary PCC transport** — pending Phase 0 matrix.
2. **Busy error vs queue** for overlapping prompts — default recommendation: queue with cap, busy error if cap exceeded.
3. **Distribute strategy** — compile `dist/` vs bundle vs tsx-in-prod.
4. **Keep afm as default on-device path** even if serve-socket works? Recommendation: serve-socket first when healthy (system-signed, one protocol), afm second for structured/bridge features if still needed.
5. **Helper authentication mechanism** — peer creds vs HMAC token file `0600`; prefer OS peer identity on macOS if practical in Node.

---

## 15. References (local + external)
### Local code anchors
- `src/adapter.ts` — silent session create on prompt; abort overwrite; image capability advertise
- `src/session-store.ts` — path join, lock, fail-open load, default modes
- `src/process.ts` — killed flag escalation; void callbacks; signal→0
- `src/helper-bootstrap.ts` — dual AppleScript launch
- `bin/fm-acp-terminal-helper.mjs` — unlink socket; per-connection activeChild; argv leak; unbounded buffers
- `src/backends/resolve.ts` — fallback loop
- `src/map.ts` — absolute-path-only images
- `package.json` — link dep, postinstall, test surface

### System
- `/usr/bin/fm serve --help` — `--socket`, `/health`, `/v1/models`, `/v1/chat/completions`, models `system`|`pcc`

### Prior plans
- Terminal helper plan `f38636d0-2604-4b2a-aec5-a7f8a5b6a23f`
- Original fm-acp plan `d785b48d-f5a6-4c85-b343-e407f5b0aa94`
- Concise hardening plan `b57149e3-ca59-41a5-8b9f-67f9cdf0f35c`

### Prior art / docs to reuse during implementation
- Apple WWDC26 fm CLI / Foundation Models updates (serve, PCC, vision)
- `gregbarbosa/fm-proxy` patterns for serve-fronted local proxying
- ACP SDK 1.3.0 session lifecycle contracts
- Mature ACP adapters’ prompt queue + update chain patterns

---

## 16. Approval checkpoint

**No implementation, diffs, or live Warp TODOs until explicit approval.**

On approval, proceed with:
1. Create live TODO list from §12
2. Execute Phase 0 immediately
3. Update this document and the concise Warp plan as Phase 0 decides transport
4. Implement Phase 1 before any feature/transport expansion
