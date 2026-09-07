#!/usr/bin/env node
process.stderr.write("This routing-only capability does not spawn a per-call Computer Use process. Use the DevSpace top-level codex_computer_use tool, which delegates to the shared persistent Codex node_repl + @oai/sky runtime.\n");
process.exitCode = 2;
