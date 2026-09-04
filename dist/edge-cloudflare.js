import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKER_NAME = "devspace-ultra-mcp-edge";
const DEFAULT_WRANGLER_CONFIG = join(packageRoot, "edge", "cloudflare-worker", "wrangler.jsonc");
const DEFAULT_EDGE_STARTUP_SCRIPT = join(packageRoot, "scripts", "devspace-edge-startup.ps1");

export function normalizeHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Expected a valid HTTPS origin base URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("Fixed edge requires an HTTPS origin.");
  if (parsed.username || parsed.password) throw new Error("Origin URL must not contain credentials.");
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Origin base URL must not contain a path, query, or fragment.");
  }
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeFixedPublicBaseUrl(value) {
  const normalized = normalizeHttpsOrigin(value);
  return normalized;
}

function hostOf(value) {
  return new URL(value).hostname.toLowerCase();
}

export function planFixedEdgeCandidateConfig(existingConfig, {
  backendPort = 7677,
  fixedStateDir,
  ...edgeOptions
} = {}) {
  if (!Number.isInteger(Number(backendPort)) || Number(backendPort) < 1024 || Number(backendPort) > 65535 || Number(backendPort) === 7676) {
    throw new Error("Fixed edge candidate backendPort must be a non-control port between 1024 and 65535.");
  }
  const planned = planFixedEdgeConfig(existingConfig, edgeOptions);
  const next = {
    ...planned,
    edgeBackendPort: Number(backendPort),
    ...(fixedStateDir ? { edgeFixedStateDir: String(fixedStateDir) } : {}),
  };
  if (Object.prototype.hasOwnProperty.call(existingConfig ?? {}, "publicBaseUrl")) next.publicBaseUrl = existingConfig.publicBaseUrl;
  else delete next.publicBaseUrl;
  if (Object.prototype.hasOwnProperty.call(existingConfig ?? {}, "port")) next.port = existingConfig.port;
  else delete next.port;
  if (Object.prototype.hasOwnProperty.call(existingConfig ?? {}, "stateDir")) next.stateDir = existingConfig.stateDir;
  else delete next.stateDir;
  return next;
}

export function planFixedEdgeConfig(existingConfig, {
  originBaseUrl,
  publicBaseUrl,
  workerName = DEFAULT_WORKER_NAME,
  transportMode = "public-origin",
  tunnelId,
  tunnelName,
  vpcServiceId,
  vpcServiceName,
} = {}) {
  const origin = originBaseUrl ? normalizeHttpsOrigin(originBaseUrl) : null;
  const publicBase = normalizeFixedPublicBaseUrl(publicBaseUrl);
  if (origin && origin === publicBase) throw new Error("Fixed edge public URL must differ from its origin base URL.");
  if (transportMode === "workers-vpc" && (!tunnelId || !vpcServiceId)) {
    throw new Error("Workers VPC edge requires both tunnelId and vpcServiceId.");
  }
  const currentHosts = Array.isArray(existingConfig?.allowedHosts) ? existingConfig.allowedHosts : [];
  const allowedHosts = Array.from(new Set([
    ...currentHosts.map((value) => String(value).trim()).filter(Boolean),
    "localhost",
    "127.0.0.1",
    "::1",
    ...(origin ? [hostOf(origin)] : []),
    hostOf(publicBase),
  ]));
  return {
    ...(existingConfig || {}),
    publicBaseUrl: publicBase,
    allowedHosts,
    edgeProvider: "cloudflare-worker",
    edgeTransportMode: transportMode,
    edgePreviousPublicBaseUrl: existingConfig?.edgePreviousPublicBaseUrl ?? existingConfig?.publicBaseUrl ?? null,
    ...(origin ? { edgeOriginBaseUrl: origin } : {}),
    edgePublicBaseUrl: publicBase,
    edgeWorkerName: String(workerName || DEFAULT_WORKER_NAME).trim() || DEFAULT_WORKER_NAME,
    ...(tunnelId ? { edgeTunnelId: String(tunnelId) } : {}),
    ...(tunnelName ? { edgeTunnelName: String(tunnelName) } : {}),
    ...(vpcServiceId ? { edgeVpcServiceId: String(vpcServiceId) } : {}),
    ...(vpcServiceName ? { edgeVpcServiceName: String(vpcServiceName) } : {}),
  };
}

export function planDisableEdgeConfig(existingConfig) {
  const next = { ...(existingConfig || {}) };
  // Fixed-edge metadata is orthogonal to the live/default control backend.
  // Disabling the edge must never rewrite control publicBaseUrl/port/stateDir.
  delete next.edgeProvider;
  delete next.edgeTransportMode;
  delete next.edgePreviousPublicBaseUrl;
  delete next.edgeOriginBaseUrl;
  delete next.edgePublicBaseUrl;
  delete next.edgeWorkerName;
  delete next.edgeTunnelId;
  delete next.edgeTunnelName;
  delete next.edgeVpcServiceId;
  delete next.edgeVpcServiceName;
  delete next.edgeBackendPort;
  delete next.edgeFixedStateDir;
  return next;
}

export function classifyEdgeConfig(config = {}) {
  const publicBaseUrl = String(config.publicBaseUrl || "").trim();
  const edgePublicBaseUrl = String(config.edgePublicBaseUrl || "").trim();
  const hasEdgeMetadata = Boolean(config.edgeProvider || config.edgeOriginBaseUrl || edgePublicBaseUrl);

  if (!hasEdgeMetadata) {
    if (/\.trycloudflare\.com(?:$|\/)/i.test(publicBaseUrl)) {
      return { mode: "temporary", publicBaseUrl };
    }
    return { mode: "direct", publicBaseUrl };
  }

  const fixedProvider = config.edgeProvider === "cloudflare-worker";
  const fixedUrl = Boolean(edgePublicBaseUrl)
    && !/\.trycloudflare\.com(?:$|\/)/i.test(edgePublicBaseUrl)
    && /^https:\/\//i.test(edgePublicBaseUrl);
  const transportReady = config.edgeTransportMode === "workers-vpc"
    ? Boolean(config.edgeTunnelId && config.edgeVpcServiceId && Number(config.edgeBackendPort) !== 7676)
    : Boolean(config.edgeOriginBaseUrl);
  return {
    mode: fixedProvider && fixedUrl && transportReady ? "fixed" : "misconfigured",
    publicBaseUrl,
    controlPublicBaseUrl: publicBaseUrl,
    originBaseUrl: config.edgeOriginBaseUrl ?? null,
    edgePublicBaseUrl: edgePublicBaseUrl || null,
    provider: config.edgeProvider ?? null,
    transportMode: config.edgeTransportMode ?? null,
    tunnelId: config.edgeTunnelId ?? null,
    vpcServiceId: config.edgeVpcServiceId ?? null,
    backendPort: config.edgeBackendPort ?? null,
  };
}

function normalizeLoose(value) {
  try { return new URL(String(value)).toString().replace(/\/$/, ""); }
  catch { return String(value || "").replace(/\/$/, ""); }
}

export function findTunnelIdByName(output, name) {
  const target = String(name || "").trim();
  if (!target) return null;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.includes(target)) continue;
    const match = line.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

export function findVpcServiceIdByName(output, name) {
  const target = String(name || "").trim();
  if (!target) return null;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.includes(target)) continue;
    const match = line.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

export function extractTunnelId(output) {
  const match = String(output || "").match(/\bID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i);
  if (!match) throw new Error("Wrangler output did not contain a Cloudflare tunnel id.");
  return match[1].toLowerCase();
}

export function extractVpcServiceId(output) {
  const match = String(output || "").match(/Created VPC service:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (!match) throw new Error("Wrangler output did not contain a VPC service id.");
  return match[1].toLowerCase();
}

export function buildVpcWorkerConfig({
  workerName = DEFAULT_WORKER_NAME,
  mainPath = "src/index.js",
  serviceId,
} = {}) {
  const name = String(workerName || DEFAULT_WORKER_NAME).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) throw new Error("Cloudflare Worker name is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(String(serviceId || ""))) throw new Error("Workers VPC service id is invalid.");
  return {
    name,
    main: mainPath,
    compatibility_date: "2026-09-04",
    workers_dev: true,
    vpc_services: [{
      binding: "PRIVATE_ORIGIN",
      service_id: String(serviceId).toLowerCase(),
      remote: true,
    }],
  };
}

export function extractWorkersDevUrl(output) {
  const matches = String(output || "").match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.workers\.dev\/?/ig) || [];
  if (matches.length === 0) throw new Error("Wrangler deploy output did not contain a workers.dev URL.");
  return normalizeFixedPublicBaseUrl(matches.at(-1));
}

export function buildWranglerDeployArgs({
  originBaseUrl,
  workerName = DEFAULT_WORKER_NAME,
  configPath = "edge/cloudflare-worker/wrangler.jsonc",
} = {}) {
  const origin = normalizeHttpsOrigin(originBaseUrl);
  const name = String(workerName || DEFAULT_WORKER_NAME).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) throw new Error("Cloudflare Worker name is invalid.");
  return [
    "wrangler@4",
    "deploy",
    "--config",
    configPath,
    "--name",
    name,
    "--var",
    `ORIGIN_BASE_URL:${origin}`,
  ];
}

export function resolveNpxInvocation(args, {
  platform = process.platform,
  execPath = process.execPath,
  npxCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
} = {}) {
  if (platform === "win32") {
    return { command: execPath, args: [npxCliPath, ...args] };
  }
  return { command: "npx", args: [...args] };
}

export async function runNpx(args, { cwd = packageRoot, env = process.env, timeoutMs = 180_000 } = {}) {
  const invocation = resolveNpxInvocation(args);
  if (process.platform === "win32" && !existsSync(invocation.args[0])) {
    throw new Error(`Unable to locate npm npx CLI at ${invocation.args[0]}.`);
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: Number(code ?? 1), stdout, stderr });
    });
  });
}

export async function resolveWranglerAuthEnv(baseEnv = process.env) {
  const direct = await runNpx(["wrangler@4", "whoami"], { env: baseEnv, timeoutMs: 90_000 });
  if (direct.code === 0) return { env: baseEnv, mode: baseEnv.CLOUDFLARE_API_TOKEN ? "api-token" : "oauth" };
  if (baseEnv.CLOUDFLARE_API_TOKEN) {
    const oauthEnv = { ...baseEnv };
    delete oauthEnv.CLOUDFLARE_API_TOKEN;
    delete oauthEnv.CLOUDFLARE_ACCOUNT_ID;
    const fallback = await runNpx(["wrangler@4", "whoami"], { env: oauthEnv, timeoutMs: 90_000 });
    if (fallback.code === 0) return { env: oauthEnv, mode: "oauth-fallback" };
  }
  throw new Error("Wrangler is not authenticated for Cloudflare deployment. Run `wrangler login` once, then retry.");
}

export async function ensureCloudflareTunnel({
  name = "devspace-ultra-origin",
  env = process.env,
} = {}) {
  const listed = await runNpx(["wrangler@4", "tunnel", "list"], { env, timeoutMs: 120_000 });
  if (listed.code !== 0) throw new Error("Unable to list Cloudflare Tunnels with Wrangler.");
  const existingId = findTunnelIdByName(`${listed.stdout}\n${listed.stderr}`, name);
  if (existingId) return { id: existingId, name, created: false };
  const created = await runNpx(["wrangler@4", "tunnel", "create", name], { env, timeoutMs: 120_000 });
  if (created.code !== 0) throw new Error(`Unable to create Cloudflare Tunnel ${name}.`);
  return { id: extractTunnelId(`${created.stdout}\n${created.stderr}`), name, created: true };
}

export function startCloudflareTunnelDetached(tunnelId, {
  env = process.env,
  cwd = packageRoot,
} = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(tunnelId || ""))) throw new Error("Cloudflare tunnel id is invalid.");
  const invocation = resolveNpxInvocation(["--yes", "wrangler@4", "tunnel", "run", String(tunnelId)]);
  if (process.platform === "win32" && !existsSync(invocation.args[0])) {
    throw new Error(`Unable to locate npm npx CLI at ${invocation.args[0]}.`);
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    windowsHide: true,
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, tunnelId: String(tunnelId), started: true };
}

export async function ensureVpcService({
  name = "devspace-ultra-local",
  tunnelId,
  port = 7676,
  env = process.env,
} = {}) {
  if (!tunnelId) throw new Error("Workers VPC service creation requires a tunnelId.");
  const listed = await runNpx(["wrangler@4", "vpc", "service", "list"], { env, timeoutMs: 120_000 });
  if (listed.code !== 0) throw new Error("Unable to list Workers VPC services with Wrangler.");
  const existingId = findVpcServiceIdByName(`${listed.stdout}\n${listed.stderr}`, name);
  if (existingId) return { id: existingId, name, created: false, port };
  const created = await runNpx([
    "wrangler@4", "vpc", "service", "create", name,
    "--type", "http",
    "--tunnel-id", tunnelId,
    "--ipv4", "127.0.0.1",
    "--http-port", String(port),
  ], { env, timeoutMs: 120_000 });
  if (created.code !== 0) throw new Error(`Unable to create Workers VPC service ${name}.`);
  return { id: extractVpcServiceId(`${created.stdout}\n${created.stderr}`), name, created: true, port };
}

export async function installFixedEdgeStartup({
  scriptPath = DEFAULT_EDGE_STARTUP_SCRIPT,
  timeoutMs = 120_000,
} = {}) {
  if (process.platform !== "win32") {
    return { ok: true, state: "not-required", platform: process.platform };
  }
  if (!existsSync(scriptPath)) throw new Error(`Fixed edge startup installer is missing: ${scriptPath}`);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-Action", "install",
    ], {
      cwd: packageRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Fixed edge startup installation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (Number(code ?? 1) !== 0) {
        rejectPromise(new Error(`Fixed edge startup installer failed with exit code ${code}.`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        resolvePromise({ ...parsed, stderr: stderr.trim() || undefined });
      }
      catch {
        rejectPromise(new Error("Fixed edge startup installer returned invalid JSON."));
      }
    });
  });
}

export async function deployCloudflareWorkerVpc({
  serviceId,
  workerName = DEFAULT_WORKER_NAME,
  env = process.env,
} = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "devspace-edge-vpc-"));
  try {
    const workerSource = readFileSync(join(packageRoot, "edge", "cloudflare-worker", "src", "index.js"), "utf8");
    writeFileSync(join(tempRoot, "index.js"), workerSource, "utf8");
    writeFileSync(join(tempRoot, "wrangler.jsonc"), JSON.stringify(buildVpcWorkerConfig({
      workerName,
      mainPath: "index.js",
      serviceId,
    }), null, 2) + "\n", "utf8");
    const result = await runNpx(["wrangler@4", "deploy", "--config", "wrangler.jsonc"], {
      cwd: tempRoot,
      env,
      timeoutMs: 240_000,
    });
    if (result.code !== 0) {
      const safeTail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-20).join("\n");
      throw new Error(`Wrangler VPC deployment failed with exit code ${result.code}.${safeTail ? `\n${safeTail}` : ""}`);
    }
    return {
      ok: true,
      workerName,
      publicBaseUrl: extractWorkersDevUrl(`${result.stdout}\n${result.stderr}`),
      vpcServiceId: serviceId,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function deployCloudflareWorker({
  originBaseUrl,
  workerName = DEFAULT_WORKER_NAME,
  configPath = DEFAULT_WRANGLER_CONFIG,
  cwd = packageRoot,
  env = process.env,
} = {}) {
  const relativeConfig = resolve(configPath) === resolve(DEFAULT_WRANGLER_CONFIG)
    ? "edge/cloudflare-worker/wrangler.jsonc"
    : configPath;
  const args = buildWranglerDeployArgs({ originBaseUrl, workerName, configPath: relativeConfig });
  const result = await runNpx(args, { cwd, env, timeoutMs: 240_000 });
  if (result.code !== 0) {
    const safeTail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-20).join("\n");
    throw new Error(`Wrangler deployment failed with exit code ${result.code}.${safeTail ? `\n${safeTail}` : ""}`);
  }
  const publicBaseUrl = extractWorkersDevUrl(`${result.stdout}\n${result.stderr}`);
  return {
    ok: true,
    workerName,
    publicBaseUrl,
    originBaseUrl: normalizeHttpsOrigin(originBaseUrl),
  };
}

async function jsonOrNull(response) {
  try { return await response.json(); }
  catch { return null; }
}

export async function probeFixedEdge(baseUrl, fetchImpl = fetch) {
  const base = normalizeFixedPublicBaseUrl(baseUrl);
  const healthResponse = await fetchImpl(`${base}/healthz`, { redirect: "manual", cache: "no-store" });
  const health = await jsonOrNull(healthResponse.clone());
  const mcpResponse = await fetchImpl(`${base}/mcp`, { redirect: "manual", cache: "no-store" });
  const challenge = mcpResponse.headers.get("www-authenticate") || "";
  const prmResponse = await fetchImpl(`${base}/.well-known/oauth-protected-resource/mcp`, { redirect: "manual", cache: "no-store" });
  const prm = await jsonOrNull(prmResponse);
  const authResponse = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, { redirect: "manual", cache: "no-store" });
  const auth = await jsonOrNull(authResponse);
  const blockedResponse = await fetchImpl(`${base}/browser-control/bridge/next`, { redirect: "manual", cache: "no-store" });
  const expectedResource = `${base}/mcp`;
  const expectedIssuer = `${base}/`;
  return {
    ok: Boolean(
      healthResponse.ok && health?.ok === true &&
      mcpResponse.status === 401 && /resource_metadata=/i.test(challenge) &&
      prmResponse.ok && prm?.resource === expectedResource &&
      authResponse.ok && auth?.issuer === expectedIssuer &&
      new URL(auth?.token_endpoint || "about:blank").origin === base &&
      new URL(auth?.registration_endpoint || "about:blank").origin === base &&
      blockedResponse.status === 404
    ),
    publicBaseUrl: base,
    healthStatus: healthResponse.status,
    healthOk: health?.ok === true,
    mcpStatus: mcpResponse.status,
    challengePresent: /resource_metadata=/i.test(challenge),
    prmStatus: prmResponse.status,
    prmResource: prm?.resource ?? null,
    authStatus: authResponse.status,
    issuer: auth?.issuer ?? null,
    tokenEndpoint: auth?.token_endpoint ?? null,
    registrationEndpoint: auth?.registration_endpoint ?? null,
    privateSurfaceStatus: blockedResponse.status,
  };
}

export const fixedEdgeDefaults = Object.freeze({
  workerName: DEFAULT_WORKER_NAME,
  wranglerConfig: DEFAULT_WRANGLER_CONFIG,
});
