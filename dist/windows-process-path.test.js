import assert from "node:assert/strict";
import { resolveFreshWindowsProcessEnvironment, withCanonicalWindowsPath } from "./windows-process-path.js";

assert.deepEqual(withCanonicalWindowsPath({ PATH: "old", Path: "duplicate", HOME: "home" }, "new"), {
  HOME: "home",
  Path: "new",
});

{
  const result = await resolveFreshWindowsProcessEnvironment({ PATH: "old-path", KEEP: "yes" }, {
    platform: "win32",
    run: async (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.equal(args.includes("-NonInteractive"), true);
      assert.equal(options.env.PATH, "old-path");
      return { stdout: "C:\\Windows;C:\\Tools\r\n" };
    },
  });
  assert.equal(result.pathSource, "windows-machine-user-registry");
  assert.equal(result.refreshed, true);
  assert.equal(result.env.Path, "C:\\Windows;C:\\Tools");
  assert.equal(result.env.KEEP, "yes");
  assert.equal(Object.hasOwn(result.env, "PATH"), false);
}

{
  const result = await resolveFreshWindowsProcessEnvironment({ Path: "fallback", KEEP: "yes" }, {
    platform: "win32",
    run: async () => { throw new Error("PowerShell unavailable"); },
  });
  assert.equal(result.pathSource, "inherited-fallback");
  assert.equal(result.env.Path, "fallback");
  assert.equal(result.env.KEEP, "yes");
}

{
  const source = { PATH: "/usr/bin", KEEP: "yes" };
  const result = await resolveFreshWindowsProcessEnvironment(source, {
    platform: "linux",
    run: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.pathSource, "inherited-non-windows");
  assert.deepEqual(result.env, source);
  assert.notEqual(result.env, source);
}

console.log(JSON.stringify({
  ok: true,
  gate: "windows-process-path",
  registryPathRefresh: true,
  duplicatePathKeysRemoved: true,
  safeFallback: true,
}));
