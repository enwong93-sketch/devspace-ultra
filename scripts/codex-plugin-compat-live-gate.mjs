import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";

async function walk(dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, out);
    else if (entry.isFile() && entry.name === "plugin.json" && dirname(file).endsWith(`${sep}.codex-plugin`)) out.push(file);
  }
  return out;
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function normalizePaths(value) {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : [];
}

async function countSkillFiles(dir) {
  if (!await isDirectory(dir)) return 0;
  let count = 0;
  async function visit(current) {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") count += 1;
    }
  }
  await visit(dir);
  return count;
}

async function main() {
  const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const pluginsRoot = join(codexRoot, "plugins");
  if (!existsSync(pluginsRoot)) throw new Error(`Codex plugin directory not found: ${pluginsRoot}`);
  const manifests = (await walk(pluginsRoot)).sort();
  const rows = [];
  for (const manifestPath of manifests) {
    const pluginRoot = dirname(dirname(manifestPath));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const temp = await mkdtemp(join(tmpdir(), "devspace-codex-plugin-audit-"));
    try {
      const runtime = new CapabilityRuntime({
        enabled: true,
        pluginsDir: join(temp, "plugins"),
        registryPath: join(temp, "plugins", "registry.json"),
        pluginPaths: [pluginRoot],
      });
      try {
        await runtime.ready;
        const list = await runtime.list({ includeDisabled: true, probeMcp: false });
        if (list.length !== 1) throw new Error(`Expected one plugin, got ${list.length}.`);
        const plugin = await runtime.inspect(list[0].id, { probeMcp: false });
        const failures = [];
        if (!plugin.detectedFormats.includes("codex-plugin")) failures.push("codex-plugin manifest not detected");

        const knownManifestKeys = new Set(["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "apps", "interface", "bundledContentVariant", "mcpServers", "hooks", "requires_local_executor"]);
        const unknownKeys = Object.keys(manifest).filter((key) => !knownManifestKeys.has(key));
        if (unknownKeys.length) failures.push(`unknown manifest keys: ${unknownKeys.join(", ")}`);

        const declaredSkillPaths = normalizePaths(manifest.skills);
        let declaredSkillCount = 0;
        for (const value of declaredSkillPaths) {
          const path = resolve(pluginRoot, value);
          if (!existsSync(path)) failures.push(`missing skills path: ${value}`);
          declaredSkillCount += await countSkillFiles(path);
        }
        if (declaredSkillCount > 0 && plugin.skills.length < declaredSkillCount) {
          failures.push(`skills incomplete ${plugin.skills.length}/${declaredSkillCount}`);
        }

        const declaredMcpPaths = normalizePaths(manifest.mcpServers);
        let existingMcpFiles = 0;
        for (const value of declaredMcpPaths) {
          if (existsSync(resolve(pluginRoot, value))) existingMcpFiles += 1;
          else failures.push(`missing MCP config: ${value}`);
        }
        if (existingMcpFiles > 0 && plugin.mcpServers.length === 0) failures.push("declared MCP config not discovered");

        const declaredAppPaths = normalizePaths(manifest.apps);
        let expectedApps = 0;
        for (const value of declaredAppPaths) {
          const file = resolve(pluginRoot, value);
          if (!existsSync(file)) {
            failures.push(`missing app config: ${value}`);
            continue;
          }
          const appConfig = JSON.parse(await readFile(file, "utf8"));
          expectedApps += Object.keys(appConfig.apps || {}).length;
        }
        if (plugin.codexApps.length < expectedApps) failures.push(`apps incomplete ${plugin.codexApps.length}/${expectedApps}`);

        const declaredHookPaths = normalizePaths(manifest.hooks);
        let expectedHooks = 0;
        for (const value of declaredHookPaths) {
          if (existsSync(resolve(pluginRoot, value))) expectedHooks += 1;
          else failures.push(`missing hook config: ${value}`);
        }
        if (plugin.codexHooks.length < expectedHooks) failures.push(`hooks incomplete ${plugin.codexHooks.length}/${expectedHooks}`);
        if (manifest.interface && plugin.codexInterfaces.length === 0) failures.push("interface metadata missing");
        if (manifest.bundledContentVariant !== undefined && plugin.bundledContentVariants.length === 0) failures.push("bundledContentVariant missing");
        if (manifest.requires_local_executor !== undefined) {
          const requirements = Array.isArray(plugin.codexExecutionRequirements) ? plugin.codexExecutionRequirements : [];
          if (!requirements.length) failures.push("requires_local_executor metadata missing");
          else if (requirements.some((item) => item.declaredValueValid !== true)) failures.push("requires_local_executor must be boolean");
          else if (!requirements.some((item) => item.requiresLocalExecutor === (manifest.requires_local_executor === true))) failures.push("requires_local_executor value mismatch");
        }

        rows.push({
          name: manifest.name || plugin.id,
          version: manifest.version || plugin.version,
          path: relative(codexRoot, pluginRoot).split(sep).join("/"),
          formats: plugin.detectedFormats,
          skills: plugin.skills.length,
          mcpServers: plugin.mcpServers.length,
          apps: plugin.codexApps.length,
          hooks: plugin.codexHooks.length,
          interface: plugin.codexInterfaces.length > 0,
          bundledContentVariant: plugin.bundledContentVariants.length > 0,
          requiresLocalExecutor: plugin.codexExecutionRequirements?.some((item) => item.requiresLocalExecutor === true) || false,
          compatible: failures.length === 0,
          failures,
        });
      }
      finally { await runtime.close(); }
    }
    finally { await rm(temp, { recursive: true, force: true }); }
  }

  const failures = rows.filter((row) => !row.compatible);
  const activeCache = rows.filter((row) => row.path.startsWith("plugins/cache/"));
  const sources = rows.filter((row) => row.path.startsWith("plugins/sources/"));
  const platformApps = rows.filter((row) => row.apps > 0);
  const hostHooks = rows.filter((row) => row.hooks > 0);
  const mcpPlugins = rows.filter((row) => row.mcpServers > 0);
  const skillPlugins = rows.filter((row) => row.skills > 0);
  console.log(JSON.stringify({
    ok: failures.length === 0,
    manifestsScanned: rows.length,
    compatible: rows.length - failures.length,
    failed: failures.length,
    activeCachePlugins: activeCache.length,
    sourceTreePlugins: sources.length,
    skillPlugins: skillPlugins.length,
    mcpPlugins: mcpPlugins.length,
    platformAppDependencyPlugins: platformApps.length,
    codexHostHookPlugins: hostHooks.length,
    semantics: {
      skills: "directly reusable by DevSpace",
      mcp: "directly launchable/proxyable subject to the plugin runtime, credentials, OS and external-service availability",
      apps: "manifest-compatible host dependency; execution remains platform-managed by the corresponding OpenAI/ChatGPT app connector",
      hooks: "manifest-compatible host lifecycle metadata; not auto-executed by DevSpace without an equivalent trusted lifecycle adapter",
    },
    failures,
    rows,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

await main();
