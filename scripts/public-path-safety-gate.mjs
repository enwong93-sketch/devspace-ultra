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
const placeholderProfileNames = new Set(["example", "example-user", "sample", "test", "user", "username"]);
const profilePathPatterns = [
  { id: "windows-user-profile", regex: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>]+)/gi },
  { id: "posix-user-profile", regex: /\/(?:home|Users)\/([^/\s"'`<>]+)/gi },
];
const privateInstanceHost = /\bdevspace(?:-[a-z0-9-]+){1,4}(?:\.[a-z0-9-]+)?\.(?:duckdns\.org|workers\.dev)\b/gi;
const placeholderEndpointLabel = /^(?:(?:devspace-)?(?:example|sample|test|placeholder)(?:-|$)|your(?:-|$))/i;
const patterns = [
  { id: "machine-specific-connector-label", regex: /\bEXP[\s_-]?\d{3,}\b/gi },
  { id: "literal-bearer", regex: /Bearer\s+[A-Za-z0-9._~+\/-]{24,}/g, allowTestFixtures: true },
];

for (const file of files) {
  if (/\.(?:png|jpe?g|gif|webp|ico|zip|gz|woff2?|ttf|sqlite)$/i.test(file)) continue;
  let source;
  try { source = await readFile(resolve(root, file), "utf8"); }
  catch { continue; }
  for (const pattern of profilePathPatterns) {
    for (const match of source.matchAll(pattern.regex)) {
      if (!placeholderProfileNames.has(String(match[1]).toLowerCase())) {
        findings.push({ file, rule: pattern.id });
        break;
      }
    }
  }
  for (const match of source.matchAll(privateInstanceHost)) {
    const labels = String(match[0]).toLowerCase().split(".");
    if (!labels.some((label) => placeholderEndpointLabel.test(label))) {
      findings.push({ file, rule: "private-instance-host" });
      break;
    }
  }
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
  privateConnectorLabels: false,
  literalBearerTokens: false,
}));
