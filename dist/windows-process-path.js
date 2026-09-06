import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PATH_TIMEOUT_MS = 8_000;

function inheritedPath(env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() === "path" && typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function withCanonicalWindowsPath(env, value) {
  const next = {};
  for (const [key, entry] of Object.entries(env || {})) {
    if (key.toLowerCase() === "path") continue;
    next[key] = entry;
  }
  if (typeof value === "string" && value.trim()) next.Path = value.trim();
  return next;
}

export async function resolveFreshWindowsProcessEnvironment(baseEnv = process.env, {
  platform = process.platform,
  run = execFileAsync,
  timeoutMs = PATH_TIMEOUT_MS,
} = {}) {
  const fallback = inheritedPath(baseEnv);
  if (platform !== "win32") {
    return { env: { ...baseEnv }, pathSource: "inherited-non-windows", refreshed: false };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$machine=[Environment]::GetEnvironmentVariable('Path','Machine')",
    "$user=[Environment]::GetEnvironmentVariable('Path','User')",
    "$combined=@($machine,$user) -join ';'",
    "[Environment]::ExpandEnvironmentVariables($combined)",
  ].join("; ");
  try {
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: baseEnv,
    });
    const fresh = String(result?.stdout || "").replace(/\r?\n+$/, "").trim();
    if (!fresh) throw new Error("empty-path");
    return {
      env: withCanonicalWindowsPath(baseEnv, fresh),
      pathSource: "windows-machine-user-registry",
      refreshed: fresh !== fallback,
    };
  } catch {
    return {
      env: withCanonicalWindowsPath(baseEnv, fallback),
      pathSource: "inherited-fallback",
      refreshed: false,
    };
  }
}
