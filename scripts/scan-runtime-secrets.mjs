#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { loadDevspaceFiles } from '../dist/user-config.js';

const files = loadDevspaceFiles();
const config = loadConfig();
const roots = [
  join(files.dir, 'logs'),
  config.stateDir,
];
const patterns = [
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi],
  ['owner-token-field', /owner[_-]?token\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/gi],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
];
const hits = [];
let files = 0;
async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!entry.isFile()) continue;
    let text;
    try {
      const info = await stat(path);
      if (info.size > 8_000_000) continue;
      text = await readFile(path, 'utf8');
    } catch { continue; }
    files += 1;
    for (const [name, pattern] of patterns) {
      pattern.lastIndex = 0;
      let count = 0;
      while (pattern.exec(text) && count < 100) count += 1;
    if (count) hits.push({ file: path.replace(files.dir, '<config>').replace(config.stateDir, '<state>'), pattern: name, count });
    }
  }
}
for (const root of roots) await walk(root);
console.log(JSON.stringify({ filesScanned: files, secretPatternHits: hits, rawValuesReturned: false }, null, 2));
process.exitCode = hits.length ? 1 : 0;
