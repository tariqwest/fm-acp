# fm-acp implementation

ACP stdio adapter for Apple Foundation Models.

## Backends
- Primary: `afm` (JSON/NDJSON, bridge for PCC)
- Fallback: system `/usr/bin/fm` (`--save-transcript` / `--resume`)

## Layout
See `AGENTS.md` and `README.md`.

## Status
MVP implemented: initialize, session lifecycle, prompt/cancel, config options, unit tests, system-fm smoke.
