import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [updater, cli, pkgText, readme, installer, releaseWorkflow] = await Promise.all([
  read("update.ps1"),
  read("dist/cli.js"),
  read("package.json"),
  read("README.md"),
  read("install.ps1"),
  read(".github/workflows/release.yml"),
]);
const pkg = JSON.parse(pkgText);

assert.match(updater, /ValidateSet\("apply",\s*"check",\s*"status",\s*"install-task",\s*"remove-task"\)/,
  "updater must expose apply/check/status and auto-task lifecycle actions");
assert.match(updater, /api\.github\.com\/repos\/\$Repository\/releases\/latest/,
  "stable updates must resolve through GitHub releases/latest rather than a moving source checkout");
assert.match(updater, /devspace-ultra-\[0-9\].*\\\.tgz|devspace-ultra-\[0-9\].*\.tgz/,
  "updater must select the release npm archive asset");
assert.match(updater, /Get-FileHash\s+-Algorithm\s+SHA256/,
  "downloaded release archives must be SHA-256 verified");
assert.match(updater, /@waishnav\/devspace/,
  "legacy upstream package layout must remain migratable");
assert.match(updater, /\.devspace-update-backups/,
  "package rollback must retain an on-volume backup");
assert.match(updater, /Move-Item[\s\S]*packageBackups[\s\S]*Restore-Shims/s,
  "updater must preserve and restore old package roots and command shims");
assert.match(updater, /function Replace-PathInsensitive/);
assert.match(updater, /function Migrate-RuntimeTaskPackagePaths[\s\S]*Set-ScheduledTask/s,
  "legacy Scheduled Task actions must migrate from the old package root to the canonical package root");
assert.match(updater, /function Restore-RuntimeTaskActions[\s\S]*Set-ScheduledTask/s,
  "rollback must restore pre-update Scheduled Task actions");
assert.match(updater, /Get-ProtectedStateFingerprint[\s\S]*Assert-ProtectedStateUnchanged/s,
  "config/auth/runtime controller state must be proven unchanged across package replacement");
assert.match(updater, /\$script:TestMode\s*=\s*\$env:DEVSPACE_UPDATE_TEST_MODE\s+-eq\s+"1"/,
  "sandbox update tests must enter an explicit fail-closed test mode");
assert.match(updater, /function Get-TaskSnapshot[\s\S]*if \(\$script:TestMode\) \{ return @\(\) \}/s,
  "test mode must not inspect production Scheduled Tasks");
assert.match(updater, /function Test-PreservedUpdateTask[\s\S]*'DevSpace-Local-Ingress', 'DevSpace-Canonical-Startup'/);
assert.match(updater, /ProtectedDescendantConflict[\s\S]*Runtime retirement deferred: an owned process tree contains protected/);
assert.match(updater, /Stop-DevSpaceRuntime[\s\S]*if \(Test-PreservedUpdateTask \$task\.Name\) \{ continue \}/);
assert.match(updater, /Restart-PreviousRuntime[\s\S]*if \(Test-PreservedUpdateTask \$task\.Name\) \{ continue \}/);
assert.match(updater, /function Stop-DevSpaceRuntime[\s\S]*if \(\$script:TestMode\) \{ return \}/s,
  "test mode must not stop production DevSpace tasks or processes");
assert.match(updater, /function Restart-PreviousRuntime[\s\S]*if \(\$script:TestMode\) \{ return \}/s,
  "test mode must not start production DevSpace tasks");
assert.match(updater, /function Install-AutoUpdateTask[\s\S]*if \(\$script:TestMode\) \{ return \$false \}/s,
  "test mode must never register the production auto-update task");
assert.match(updater, /if \(-not \$script:TestMode\)[\s\S]*install-skill\.ps1/s,
  "test mode must not rewrite the operator's installed Agent Skill");
assert.match(updater, /if \(\$script:TestMode\)[\s\S]*archive-extract[\s\S]*Get-Command tar\.exe/s,
  "sandbox must validate the real tgz without reinstalling the dependency tree");
assert.match(updater, /else \{[\s\S]*npmOutput = @\(& \$npm\.Source install --global --prefix \$stagePrefix \$ArchivePath --ignore-scripts/s,
  "production staging must continue to use a real isolated npm install");
assert.match(updater, /Get-GatewayBusyState/);
assert.match(updater, /\$otherHttpActive\s*=\s*\[Math\]::Max\(0,\s*\$httpActive\s*-\s*1\)/, "updater must exclude its own gateway status request from active-work detection");
assert.match(updater, /Busy\s*=\s*\(\$toolActive\s*-gt\s*0\s*-or\s*\$processSessions\s*-gt\s*0\)/, "retained process sessions must defer updates even when HTTP/tool counters are quiet");
assert.match(updater, /core\.pid[\s\S]*core\.registries\.processSessions/, "readiness must bind aggregate process diagnostics to the exact Core PID");
assert.match(updater, /function Stop-DevSpaceRuntime[\s\S]*Get-GatewayBusyState[\s\S]*Runtime retirement deferred[\s\S]*Get-CimInstance/, "recheck readiness after staging before runtime retirement side effects");
assert.match(updater, /function Stop-DevSpaceRuntime[\s\S]*Get-NativeMaintenanceState[\s\S]*Get-GatewayBusyState[\s\S]*current native end-turn[\s\S]*RuntimeRetirementStarted = \$true/, "fresh native finals and a post-read Core check must precede retirement");
assert.match(updater, /NativeMaintenancePorts\.Count -eq 0\) \{ return \$unknown \}/, "unknown live Classic membership must defer rather than imply idle");
assert.match(updater, /function Restore-RetiredUpdateRuntime[\s\S]*if \(-not \$script:RuntimeRetirementStarted\) \{ return \}/, "a pre-retirement failure must not restart or rewrite still-running tasks");
assert.match(updater, /function Move-ItemWithRetry/);
assert.match(updater, /bounded Windows lock retries/);
assert.match(updater, /Collections\.Generic\.HashSet\[int\]/);
assert.match(updater, /row\.ParentProcessId/);
assert.match(updater, /protectedIds/);
assert.match(updater, /'caddy\.exe','ChatGPT Classic\.exe','ChatGPT\.exe'/);
assert.match(updater, /DevSpace-Stable-Gateway-Watchdog/);
assert.match(updater, /WasEnabled\s*=\s*\$task\.State\.ToString\(\) -ne "Disabled"/);
assert.match(updater, /Disable-ScheduledTask/);
assert.match(updater, /Enable-ScheduledTask/);
assert.match(updater, /foreach \(\$processId in \$stopProcessIds\)/);
assert.match(updater, /DevSpace package-owning process tree did not exit before package swap/);
assert.match(updater, /Move-ItemWithRetry -Source \$record\.Root/);
assert.match(updater, /Move-ItemWithRetry -Source \$staged\.Root/);
assert.match(updater, /npm\.Source rebuild better-sqlite3/);
assert.match(updater, /\$nativeRebuildOutput\s*=\s*@\(& \$npm\.Source rebuild better-sqlite3/,
  "native rebuild stdout must not corrupt the stage function's single-object return contract");
assert.match(updater, /\$nativeSmokeOutput\s*=\s*@\(& node -e \$smoke \$sqliteModule/,
  "native smoke stdout must remain captured inside the stage function");
assert.match(updater, /better-sqlite3 native binding did not load/);
assert.match(updater, /preservedLegacyRoots/);
assert.match(updater, /devspace-stable-gateway-startup\.ps1/);
assert.match(updater, /-Action install -ConfigDir \$gatewayConfigDir/);
assert.match(updater, /if \(-not \$busy\.Known -or \$busy\.Busy\)/,
  "automatic update must defer instead of interrupting active Agent/tool work");
assert.match(updater, /DevSpace-Ultra-Auto-Update/);
assert.match(updater, /New-ScheduledTaskTrigger\s+-Daily/,
  "successful Windows installs must be able to keep themselves on stable automatically");
assert.match(updater, /current[\s\S]*repair|repair[\s\S]*current/s,
  "same-version maintenance refreshes must be repairable by release digest, not semver alone");
assert.match(cli, /case "update"/);
assert.match(cli, /self-update/);
assert.match(cli, /WaitForProcessId/,
  "CLI updater must detach and wait for its own old package process to exit before replacement");
assert.equal(pkg.files.includes("update.ps1"), true, "update.ps1 must ship inside every future package");
assert.match(releaseWorkflow, /update\.ps1/,
  "GitHub releases must publish the bootstrap updater as a standalone asset");
assert.match(readme, /devspace update/,
  "README must document the installed updater command");
assert.match(readme, /releases\/latest[\s\S]*update\.ps1[\s\S]*Get-FileHash/s,
  "legacy bootstrap instructions must download the latest stable updater asset and verify its digest");
assert.match(installer, /Invoke-LatestStableUpdater[\s\S]*releases\/latest/s,
  "current installer must route existing official installs through the latest stable transactional updater");
assert.match(installer, /Get-FileHash\s+-Algorithm\s+SHA256[\s\S]*update\.ps1/s,
  "installer bootstrap must verify update.ps1 before executing it");
assert.match(installer, /-Action\s+install-task/,
  "fresh installs must enable the future automatic update path");

console.log(JSON.stringify({
  ok: true,
  gate: "self-update-static",
  githubLatestStable: true,
  archiveSha256Verified: true,
  legacyPackageMigration: true,
  legacyScheduledTaskMigration: true,
  packageRollback: true,
  protectedStatePreserved: true,
  sandboxProductionIsolation: true,
  busyAutoDeferral: true,
  sameVersionDigestRepair: true,
  digestVerifiedLegacyBootstrap: true,
  installerUsesTransactionalUpgrade: true,
  automaticFutureUpdates: true,
  cliEntryPoint: "devspace update",
}));
