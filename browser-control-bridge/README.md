# Retired DevSpace Browser Control extension

> **Retired. Do not install, pair, or use this extension.**

The custom Chrome/Chromium `browser_control_*` driver was replaced by the installed OpenAI Codex Computer Use runtime. Production DevSpace no longer registers the extension tool surface. The local `/browser-control/bridge/*` endpoint returns HTTP 410 and identifies `codex_computer_use` as the replacement.

Current browser automation path:

```text
codex_computer_use
  -> persistent linked Codex node_repl
  -> @oai/sky
  -> selected visible Chrome/Edge window
```

The source files in this directory are retained only for historical migration and repository archaeology. They are excluded from new npm packages and are not part of the production verification path.

See [`docs/browser-control-architecture.md`](../docs/browser-control-architecture.md) for the current native browser gate, action discipline, conversation isolation, and safety boundary.
