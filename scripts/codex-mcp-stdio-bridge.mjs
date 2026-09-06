#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexMcpExecutionFingerprint,
  parseCodexMcpConfig,
  sanitizeCodexMcpServer,
} from "../dist/codex-mcp-config.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

function fail(message, exitCode = 2) {
  process.stderr.write(`Codex MCP bridge refused to launch: ${message}\n`);
  process.exit(exitCode);
}

const serverName = argument("server").trim();
const expectedFingerprint = argument("expected-fingerprint").trim();
const configPath = resolve(argument("config", join(homedir(), ".codex", "config.toml")));
if (!serverName) fail("--server is required.");
if (!/^[a-f0-9]{64}$/i.test(expectedFingerprint)) fail("--expected-fingerprint must be a SHA-256 value.");

let text;
try {
  text = await readFile(configPath, "utf8");
} catch (error) {
  fail(`cannot read Codex configuration (${error instanceof Error ? error.code || error.name : "read-error"}).`);
}

let rawServers;
try {
  rawServers = parseCodexMcpConfig(text);
} catch (error) {
  fail(`Codex configuration cannot be parsed (${error instanceof Error ? error.message : String(error)}).`);
}
const raw = rawServers[serverName];
if (!raw || typeof raw !== "object") fail(`server ${serverName} no longer exists in the Codex configuration.`);
const sanitized = sanitizeCodexMcpServer(serverName, raw);
if (sanitized.status !== "importable-stdio") fail(`server ${serverName} is now ${sanitized.status}. Re-run the audited import before trusting it.`);
const observedFingerprint = codexMcpExecutionFingerprint(sanitized);
if (observedFingerprint !== expectedFingerprint) fail(`server ${serverName} executable surface changed. Re-run the audited import and review the new command/arguments.`);

const command = sanitized.command;
const args = sanitized.args;
const cwd = sanitized.cwd ? resolve(sanitized.cwd) : undefined;
const configuredEnv = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : {};
const env = { ...process.env };
for (const [name, value] of Object.entries(configuredEnv)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`server ${serverName} contains an invalid environment variable name.`);
  if (!["string", "number", "boolean"].includes(typeof value)) fail(`server ${serverName} environment variable ${name} is not scalar.`);
  env[name] = String(value);
}

const child = spawn(command, args, {
  cwd,
  env,
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const forward = (signal) => {
  try { child.kill(signal); } catch {}
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
child.once("error", (error) => {
  process.stderr.write(`Codex MCP bridge launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = Number(code ?? 1);
});
