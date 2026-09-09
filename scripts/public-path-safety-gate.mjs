import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
  cwd: root,
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
});

const files = stdout.split("\0").filter(Boolean);
const findings = [];
const patterns = [
  { id: "local-user-profile", regex: new RegExp(String.raw`C:\\Users\\` + "en" + "wong", "gi") },
  { id: "local-scratch-drive", regex: new RegExp(String.raw`D:\\` + "Codex" + "Scratch", "gi") },
  { id: "private-duckdns-host", regex: new RegExp("devspace-" + "enwong" + String.raw`\.duckdns\.org`, "gi") },
  { id: "private-worker-host", regex: new RegExp("devspace-ultra-mcp-edge." + "enwong93" + String.raw`\.workers\.dev`, "gi") },
  { id: "literal-bearer", regex: /Bearer\s+[A-Za-z0-9._~+\/-]{24,}/g, allowTestFixtures: true },
];

for (const file of files) {
  if (/\.(?:png|jpe?g|gif|webp|ico|zip|gz|woff2?|ttf|sqlite)$/i.test(file)) continue;
  let source;
  try { source = await readFile(resolve(root, file), "utf8"); }
  catch { continue; }
  for (const pattern of patterns) {
    if (pattern.allowTestFixtures && /(?:^|\/)(?:[^/]+\.)?test\.(?:js|mjs|cjs|ts)$/i.test(file)) continue;
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(source)) findings.push({ file, rule: pattern.id });
  }
}

assert.deepEqual(findings, [], `Public source contains local/private data:\n${JSON.stringify(findings, null, 2)}`);
console.log(JSON.stringify({
  ok: true,
  gate: "public-path-safety",
  trackedFilesScanned: files.length,
  privateMachinePaths: false,
  privateIngressHosts: false,
  literalBearerTokens: false,
}));
