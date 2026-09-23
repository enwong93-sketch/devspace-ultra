import { execFileSync } from 'node:child_process';

const PRIMARY_PORT = 9721;
const INTERACTIVE_BASE = 9730;
const LEGACY_ALTERNATE_BASE = 19730;
const MIN_MAIN = 2;
const MAX_MAIN = 32;
const CACHE_MS = 30_000;

let cache = { at: 0, entries: [] };

function cleanMainNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_MAIN ? number : null;
}

function cleanPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function inferMainNumber(port) {
  if (port === PRIMARY_PORT) return 1;
  for (const base of [INTERACTIVE_BASE, LEGACY_ALTERNATE_BASE]) {
    const number = port - base;
    if (number >= MIN_MAIN && number <= MAX_MAIN) return number;
  }
  return null;
}

export function normalizeClassicMainProcessRows(value) {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const byRuntime = new Map();
  for (const row of rows) {
    const port = cleanPort(row?.port ?? row?.Port);
    if (!port) continue;
    const commandLine = String(row?.commandLine ?? row?.CommandLine ?? '');
    const aliasNumber = commandLine.match(/chatgpt-classic-main(\d{2})\.exe/i)?.[1];
    const mainNumber = cleanMainNumber(row?.mainNumber ?? row?.MainNumber ?? aliasNumber)
      ?? inferMainNumber(port);
    if (!mainNumber) continue;
    const runtimeKey = `main-${String(mainNumber).padStart(2, '0')}`;
    const explicitAlias = Boolean(aliasNumber || row?.mainNumber || row?.MainNumber);
    const candidate = { runtimeKey, mainNumber, port, source: 'observed-process', explicitAlias };
    const previous = byRuntime.get(runtimeKey);
    if (!previous || (candidate.explicitAlias && !previous.explicitAlias)) byRuntime.set(runtimeKey, candidate);
  }
  return [...byRuntime.values()].sort((a, b) => a.mainNumber - b.mainNumber);
}

function discoverWindowsRows() {
  if (process.platform !== 'win32' || process.env.DEVSPACE_DISABLE_CLASSIC_PORT_DISCOVERY === 'true') return [];
  const command = [
    "$rows=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "$_.Name -eq 'ChatGPT Classic.exe' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--remote-debugging-port=(\\d+)'",
    '} | ForEach-Object {',
    "$port=[int]([regex]::Match([string]$_.CommandLine,'--remote-debugging-port=(\\d+)').Groups[1].Value);",
    "$alias=[regex]::Match([string]$_.CommandLine,'chatgpt-classic-main(\\d{2})\\.exe','IgnoreCase');",
    '[pscustomobject]@{port=$port;mainNumber=if($alias.Success){[int]$alias.Groups[1].Value}else{$null};commandLine=[string]$_.CommandLine}',
    '}; @($rows)|ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      timeout: 4_000,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

export function observedClassicMainPortEntries({ refresh = false, rows = null } = {}) {
  const now = Date.now();
  if (rows == null && !refresh && cache.entries.length && now - cache.at < CACHE_MS) {
    return cache.entries.map(entry => ({ ...entry }));
  }
  const entries = normalizeClassicMainProcessRows(rows ?? discoverWindowsRows());
  cache = { at: now, entries };
  return entries.map(entry => ({ ...entry }));
}

export function staticClassicMainPort(mainNumber) {
  const number = cleanMainNumber(mainNumber);
  if (!number) return null;
  return number === 1 ? PRIMARY_PORT : INTERACTIVE_BASE + number;
}

export function runtimeKeyForClassicPort(port) {
  const target = cleanPort(port);
  if (!target) return null;
  const observed = observedClassicMainPortEntries().find(entry => entry.port === target);
  if (observed) return observed.runtimeKey;
  const number = inferMainNumber(target);
  return number ? `main-${String(number).padStart(2, '0')}` : `main@${target}`;
}

export function runtimePortsForClassicKey(runtimeKey) {
  const match = String(runtimeKey || '').toLowerCase().match(/^main-(\d{2})$/);
  if (!match) return [];
  const number = cleanMainNumber(match[1]);
  if (!number) return [];
  const observed = observedClassicMainPortEntries()
    .filter(entry => entry.mainNumber === number)
    .map(entry => entry.port);
  const fallback = staticClassicMainPort(number);
  return [...new Set([...observed, ...(fallback ? [fallback] : [])])];
}

export function classicMainDebugPorts({ includeObserved = false, refresh = false } = {}) {
  const defaults = [PRIMARY_PORT, ...Array.from({ length: MAX_MAIN - MIN_MAIN + 1 }, (_, index) => INTERACTIVE_BASE + MIN_MAIN + index)];
  if (!includeObserved) return defaults;
  const observed = observedClassicMainPortEntries({ refresh }).map(entry => entry.port);
  return [...new Set([...observed, ...defaults])];
}

export function runtimeLabelForClassicPort(port) {
  const key = runtimeKeyForClassicPort(port);
  const match = key?.match(/^main-(\d{2})$/);
  return match ? `Main-${match[1]}` : `Main@${port}`;
}

export const classicMainDebugPortInternals = {
  PRIMARY_PORT,
  INTERACTIVE_BASE,
  LEGACY_ALTERNATE_BASE,
  MIN_MAIN,
  MAX_MAIN,
  inferMainNumber,
};
