import assert from "node:assert/strict";
import {
  TOOLCHAIN_CATALOG,
  installToolchain,
  probeExecutable,
  toolchainStatus,
} from "./toolchain.js";

assert.equal(TOOLCHAIN_CATALOG.some((tool) => tool.id === "git" && tool.tier === "core"), true);
assert.equal(TOOLCHAIN_CATALOG.some((tool) => tool.id === "rg" && tool.wingetId), true);
assert.equal(TOOLCHAIN_CATALOG.some((tool) => tool.id === "ffmpeg" && tool.tier === "media"), true);

{
  const calls = [];
  const probe = await probeExecutable({
    candidates: [["missing", ["--version"]], ["working", ["--version"]]],
  }, {
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === "missing") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      return { stdout: "working 1.2.3\n", stderr: "" };
    },
  });
  assert.equal(probe.available, true);
  assert.equal(probe.command, "working");
  assert.equal(probe.version, "working 1.2.3");
  assert.equal(calls.length, 2);
}

{
  const status = await toolchainStatus({
    ids: ["git", "jq"],
    platform: "test",
    concurrency: 2,
    run: async (command) => {
      if (command === "git") return { stdout: "git version 2.0", stderr: "" };
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(status.platform, "test");
  assert.equal(status.summary.total, 2);
  assert.equal(status.summary.available, 1);
  assert.deepEqual(status.summary.missingRecommended, ["jq"]);
  assert.equal(JSON.stringify(status).includes("not found secret"), false);
}

{
  const dry = await installToolchain({
    ids: ["jq", "fd"],
    apply: false,
    platform: "win32",
    statusOptions: {
      run: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    },
  });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.plan.map((item) => item.id), ["jq", "fd"]);
  assert.deepEqual(dry.plan.map((item) => item.provider), ["winget", "winget"]);
}

{
  const installs = [];
  const applied = await installToolchain({
    ids: ["jq"],
    apply: true,
    platform: "win32",
    statusOptions: {
      run: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    },
    run: async (command, args) => {
      installs.push([command, args]);
      return { stdout: "installed", stderr: "" };
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.results[0].state, "installed-or-already-current");
  assert.equal(installs[0][0], "winget.exe");
  assert.equal(installs[0][1].includes("jqlang.jq"), true);
  assert.equal(installs[0][1].includes("--disable-interactivity"), true);
}

await assert.rejects(() => installToolchain({ ids: ["unknown"], apply: false }), /known toolchain/i);
await assert.rejects(() => installToolchain({ ids: ["jq"], apply: true, platform: "linux", statusOptions: { run: async () => { throw new Error("missing"); } } }), /Windows winget only/);

console.log(JSON.stringify({
  ok: true,
  gate: "toolchain",
  boundedProbe: true,
  allowlistedInstall: true,
  dryRunDefault: true,
  silentWinget: true,
}));
