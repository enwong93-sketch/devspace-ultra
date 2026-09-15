import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log(JSON.stringify({
    ok: true,
    gate: "local-ingress-regression",
    skipped: true,
    reason: "windows-only",
  }));
  process.exit(0);
}

const scriptPath = fileURLToPath(new URL("./devspace-local-ingress.test.ps1", import.meta.url));
const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  { stdio: "inherit", windowsHide: true },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
