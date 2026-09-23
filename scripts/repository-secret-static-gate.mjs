import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
];
const reviewedSyntheticMatches = new Set([
  'openai-key:93faf5716142f90256b4c1c4bc2c1bc2ee0a2460d5a738d6938dda1ad4216afd',
  'openai-key:ea96254155e2ec96df1aa27e8f7e40353a9d0c6301e0e3bf50f7482d73407ce6',
]);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const findings = [];
let scanned = 0;
for (const file of files) {
  let info;
  try { info = await stat(file); } catch { continue; }
  if (!info.isFile() || info.size > 2_000_000) continue;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  scanned += 1;
  for (const [patternName, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const hash = createHash('sha256').update(match[0]).digest('hex');
      if (reviewedSyntheticMatches.has(`${patternName}:${hash}`)) continue;
      findings.push({ file, pattern: patternName, line: text.slice(0, match.index).split(/\r?\n/).length, hash });
    }
  }
}
assert.deepEqual(findings, [], `high-confidence secret candidates require review: ${JSON.stringify(findings)}`);
console.log(JSON.stringify({
  ok: true,
  gate: 'repository-secret-static',
  trackedTextFilesScanned: scanned,
  reviewedSyntheticMatches: reviewedSyntheticMatches.size,
  secretFindings: 0,
  rawCandidateValuesReturned: false,
}));
