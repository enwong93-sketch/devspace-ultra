import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 45 * 60 * 1_000;
const VSWHERE = join(
  process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe",
);

export const TOOLCHAIN_CATALOG = Object.freeze([
  { id: "git", label: "Git", tier: "core", candidates: [["git", ["--version"]]], wingetId: "Git.Git" },
  { id: "bash", label: "Bash", tier: "core", candidates: [["bash", ["--version"]], ["C:\\Program Files\\Git\\bin\\bash.exe", ["--version"]]], wingetId: "Git.Git" },
  { id: "node", label: "Node.js", tier: "core", candidates: [[process.execPath, ["--version"]], ["node", ["--version"]]], wingetId: "OpenJS.NodeJS.LTS" },
  { id: "npm", label: "npm", tier: "core", candidates: [["npm.cmd", ["--version"]], ["npm", ["--version"]]], wingetId: "OpenJS.NodeJS.LTS" },
  { id: "powershell", label: "PowerShell", tier: "core", candidates: [["pwsh.exe", ["--version"]], ["powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]]], wingetId: "Microsoft.PowerShell" },
  { id: "rg", label: "ripgrep", tier: "core", candidates: [["rg", ["--version"]]], wingetId: "BurntSushi.ripgrep.MSVC" },
  { id: "curl", label: "curl", tier: "core", candidates: [["curl.exe", ["--version"]], ["curl", ["--version"]]], wingetId: "cURL.cURL" },
  { id: "tar", label: "tar", tier: "core", candidates: [["tar.exe", ["--version"]], ["tar", ["--version"]]] },

  { id: "python", label: "Python", tier: "recommended", candidates: [["py.exe", ["-3", "--version"]], ["python.exe", ["--version"]], ["python3", ["--version"]]], wingetId: "Python.Python.3.13" },
  { id: "uv", label: "uv", tier: "recommended", candidates: [["uv", ["--version"]]], wingetId: "astral-sh.uv" },
  { id: "jq", label: "jq", tier: "recommended", candidates: [["jq", ["--version"]]], wingetId: "jqlang.jq" },
  { id: "fd", label: "fd", tier: "recommended", candidates: [["fd", ["--version"]], ["fdfind", ["--version"]]], wingetId: "sharkdp.fd" },
  { id: "gh", label: "GitHub CLI", tier: "recommended", candidates: [["gh", ["--version"]]], wingetId: "GitHub.cli" },
  { id: "7zip", label: "7-Zip", tier: "recommended", candidates: [["7z", ["i"]], ["C:\\Program Files\\7-Zip\\7z.exe", ["i"]]], wingetId: "7zip.7zip" },
  { id: "git-lfs", label: "Git LFS", tier: "recommended", candidates: [["git-lfs", ["version"]], ["git", ["lfs", "version"]]], wingetId: "GitHub.GitLFS" },
  { id: "pnpm", label: "pnpm", tier: "recommended", candidates: [["pnpm.cmd", ["--version"]], ["pnpm", ["--version"]]] },

  { id: "ffmpeg", label: "FFmpeg", tier: "media", candidates: [["ffmpeg", ["-version"]]], wingetId: "Gyan.FFmpeg" },
  { id: "imagemagick", label: "ImageMagick", tier: "media", candidates: [["magick", ["-version"]]], wingetId: "ImageMagick.ImageMagick" },
  { id: "poppler", label: "Poppler pdftoppm", tier: "media", candidates: [["pdftoppm", ["-v"]]], wingetId: "oschwartz10612.Poppler" },
  {
    id: "msvc",
    label: "MSVC C++ Build Tools",
    tier: "build",
    candidates: [[VSWHERE, [
      "-latest",
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationVersion",
    ]]],
    wingetId: "Microsoft.VisualStudio.2022.BuildTools",
    wingetOverride: "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
  },
  { id: "cmake", label: "CMake", tier: "build", candidates: [["cmake", ["--version"]]], wingetId: "Kitware.CMake" },
  { id: "ninja", label: "Ninja", tier: "build", candidates: [["ninja", ["--version"]]], wingetId: "Ninja-build.Ninja" },
  { id: "rust", label: "Rust/Cargo", tier: "build", candidates: [["cargo", ["--version"]], ["rustc", ["--version"]]], wingetId: "Rustlang.Rustup" },
  { id: "go", label: "Go", tier: "build", candidates: [["go", ["version"]]], wingetId: "GoLang.Go" },
  { id: "dotnet", label: ".NET SDK", tier: "build", candidates: [["dotnet", ["--version"]]], wingetId: "Microsoft.DotNet.SDK.9" },
  { id: "java", label: "Java", tier: "build", candidates: [["java", ["-version"]]], wingetId: "Microsoft.OpenJDK.21" },
]);

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

export async function probeExecutable(tool, {
  run = execFileAsync,
  timeoutMs = VERSION_TIMEOUT_MS,
} = {}) {
  const failures = [];
  for (const [command, args] of tool.candidates) {
    try {
      const result = await run(command, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      const version = firstLine(result?.stdout) || firstLine(result?.stderr) || "available";
      return { available: true, command, version };
    } catch (error) {
      failures.push(error?.code || error?.name || "unavailable");
    }
  }
  return { available: false, command: null, version: null, failures: [...new Set(failures)].slice(0, 3) };
}

function selectCatalog({ tiers, ids } = {}) {
  const tierSet = new Set(Array.isArray(tiers) ? tiers.map(String) : []);
  const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
  return TOOLCHAIN_CATALOG.filter((tool) => {
    if (idSet.size && !idSet.has(tool.id)) return false;
    if (tierSet.size && !tierSet.has(tool.tier)) return false;
    return true;
  });
}

export async function toolchainStatus(options = {}) {
  const selected = selectCatalog(options);
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 6)));
  const queue = [...selected];
  const rows = [];
  const worker = async () => {
    while (queue.length) {
      const tool = queue.shift();
      const probe = await probeExecutable(tool, options);
      rows.push({
        id: tool.id,
        label: tool.label,
        tier: tool.tier,
        wingetId: tool.wingetId || null,
        ...probe,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length || 1) }, worker));
  rows.sort((left, right) => TOOLCHAIN_CATALOG.findIndex((tool) => tool.id === left.id) - TOOLCHAIN_CATALOG.findIndex((tool) => tool.id === right.id));
  return {
    ok: true,
    platform: options.platform || process.platform,
    tools: rows,
    summary: {
      total: rows.length,
      available: rows.filter((row) => row.available).length,
      missing: rows.filter((row) => !row.available).length,
      missingCore: rows.filter((row) => row.tier === "core" && !row.available).map((row) => row.id),
      missingRecommended: rows.filter((row) => row.tier === "recommended" && !row.available).map((row) => row.id),
    },
  };
}

async function defaultInstaller(command, args, options) {
  return await execFileAsync(command, args, options);
}

export async function installToolchain({
  ids = [],
  tiers = [],
  apply = false,
  run = defaultInstaller,
  statusOptions = {},
  platform = process.platform,
} = {}) {
  const selected = selectCatalog({ ids, tiers });
  if (!selected.length) throw new Error("Select at least one known toolchain id or tier.");
  const before = await toolchainStatus({ ...statusOptions, ids: selected.map((tool) => tool.id) });
  const missing = before.tools.filter((row) => !row.available);
  const catalogById = new Map(selected.map((tool) => [tool.id, tool]));
  const plan = missing.map((row) => ({
    id: row.id,
    label: row.label,
    provider: row.wingetId ? "winget" : "manual",
    packageId: row.wingetId,
    override: catalogById.get(row.id)?.wingetOverride || null,
  }));
  if (!apply) return { ok: true, applied: false, before, plan };
  if (platform !== "win32") throw new Error("Automatic toolchain installation currently supports Windows winget only.");

  const results = [];
  for (const item of plan) {
    if (!item.packageId) {
      results.push({ ...item, state: "manual-required" });
      continue;
    }
    try {
      const installArgs = [
        "install",
        "--id", item.packageId,
        "--exact",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
        ...(item.override ? ["--override", item.override] : []),
      ];
      const result = await run("winget.exe", installArgs, {
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      results.push({
        ...item,
        state: "installed-or-already-current",
        output: firstLine(result?.stdout) || firstLine(result?.stderr),
      });
    } catch (error) {
      results.push({
        ...item,
        state: "failed",
        errorCode: error?.code ?? null,
        output: firstLine(error?.stdout) || firstLine(error?.stderr) || firstLine(error?.message),
      });
    }
  }
  const failed = results.filter((result) => result.state === "failed");
  return {
    ok: failed.length === 0,
    applied: true,
    before,
    plan,
    results,
    pathRefreshMayBeRequired: results.some((result) => result.state === "installed-or-already-current"),
  };
}
