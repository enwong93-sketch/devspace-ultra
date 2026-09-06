import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeCodexMcpServer } from "../dist/codex-mcp-config.js";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(options.stdin || "");
  });
}

const root = await mkdtemp(join(tmpdir(), "devspace-codex-mcp-bridge-"));
try {
  const childScript = join(root, "child.mjs");
  await writeFile(childScript, `let input=''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({input, secretPresent:process.env.BRIDGE_SECRET==='private-value'}));`);
  const configPath = join(root, "config.toml");
  const configText = [
    "[mcp_servers.fixture]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(childScript)}]`,
    'env = { BRIDGE_SECRET = "private-value" }',
    "",
  ].join("\n");
  await writeFile(configPath, configText);
  const server = sanitizeCodexMcpServer("fixture", {
    command: process.execPath,
    args: [childScript],
    env: { BRIDGE_SECRET: "private-value" },
  });
  assert.equal(server.status, "importable-stdio");

  const bridgePath = resolve("scripts/codex-mcp-stdio-bridge.mjs");
  const result = await run(process.execPath, [
    bridgePath,
    "--server", "fixture",
    "--expected-fingerprint", server.executionFingerprint,
    "--config", configPath,
  ], { stdin: "mcp-wire-data" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { input: "mcp-wire-data", secretPresent: true });
  assert.equal(result.stderr.includes("private-value"), false);

  const changedConfig = configText.replace(childScript, `${childScript}.changed`);
  await writeFile(configPath, changedConfig);
  const refused = await run(process.execPath, [
    bridgePath,
    "--server", "fixture",
    "--expected-fingerprint", server.executionFingerprint,
    "--config", configPath,
  ]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /executable surface changed/i);
  assert.equal(refused.stderr.includes("private-value"), false);

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-mcp-stdio-bridge",
    secretsRuntimeOnly: true,
    executableDriftFailsClosed: true,
    stdioTransparent: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
