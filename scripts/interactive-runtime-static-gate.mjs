import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => await readFile(resolve(root, path), "utf8");

const provisioner = await read("scripts/chat-classic-runtime-provision.ps1");
const workerWrapper = await read("scripts/chat-swarm-classic-runtime-clone.ps1");
const interactiveManager = await read("scripts/chat-classic-interactive-runtime.ps1");
const sessionSource = await read("scripts/chat-classic-session-source.ps1");
const primarySnapshot = await read("scripts/chat-classic-primary-snapshot.ps1");
const mainOrchestrator = await read("scripts/chat-classic-main-orchestrator.ps1");
const authSeed = await read("scripts/chat-swarm-classic-auth-seed.mjs");
const cdpSessionSeed = await read("scripts/chat-swarm-classic-session-seed.mjs");
const runtimeTools = await read("dist/chat-swarm-classic-runtime.js");
const server = await read("dist/server.js");
const bootstrap = await read("scripts/chat-swarm-classic-cdp-bootstrap.mjs");
const identityManager = await read("scripts/chat-swarm-classic-runtime-identity.ps1");
const interactiveAuthRelay = await read("scripts/chat-classic-interactive-auth-relay.ps1");
const interactiveAuthLiveGate = await read("scripts/chat-classic-interactive-auth-live-gate.ps1");
const gitIgnore = await read(".gitignore");
const npmIgnore = await read(".npmignore");
const packageJson = JSON.parse(await read("package.json"));

assert.match(provisioner, /ValidateSet\("worker",\s*"interactive"\)/, "provisioner must be role-aware");
assert.match(provisioner, /DevSpaceWorker/, "worker ApplicationId must remain isolated");
assert.match(provisioner, /DevSpaceInteractive/, "interactive ApplicationId must be distinct from Primary and Worker");
assert.match(provisioner, /OpenAI\.ChatGPT-Desktop\.Interactive/, "interactive package namespace must not reuse Worker or Primary identity");
assert.match(provisioner, /ChatGPT-Classic-Interactive-Runtimes/, "interactive clones need a separate runtime root");
assert.match(provisioner, /windows\.protocol/, "secondary roles must strip global protocol ownership");
assert.match(provisioner, /windows\.startupTask/, "secondary roles must strip startup ownership");
assert.match(provisioner, /windows\.appExtension/, "secondary roles must strip Copilot/app-extension ownership");
assert.match(provisioner, /Role\s*-eq\s*"worker"[\s\S]*AppListEntry/, "only worker role may be hidden from the app list");
assert.match(provisioner, /Role\s*-eq\s*"interactive"[\s\S]*RemoveAttribute\("AppListEntry"\)/, "interactive role must stay user-facing");

assert.match(workerWrapper, /chat-classic-runtime-provision\.ps1/, "worker clone entry point must reuse the role-aware provisioner");
assert.match(workerWrapper, /(?:-Role\s+worker|"-Role"\s*,\s*"worker")/, "worker wrapper must select worker role explicitly");

assert.match(interactiveManager, /chat-classic-runtime-provision\.ps1/, "interactive manager must reuse the same provisioner");
assert.match(interactiveManager, /chat-classic-session-source\.ps1/, "interactive manager must use generalized zero-login session source discovery");
assert.match(interactiveManager, /chat-swarm-classic-session-seed\.mjs/, "interactive manager must prefer the existing in-memory CDP Session Seed path");
assert.match(interactiveManager, /chat-classic-primary-snapshot\.ps1/, "interactive manager must have a controlled Primary snapshot fallback");
assert.match(interactiveManager, /\[switch\]\$NoPrimaryFallback/, "interactive setup must expose an explicit fail-closed mode that never restarts or snapshots Main-01");
assert.match(interactiveManager, /\[switch\]\$AllowControlledPrimarySnapshot/, "controlled Primary snapshot must require an explicit opt-in");
assert.match(interactiveManager, /if \(-not \$AllowControlledPrimarySnapshot\)[\s\S]*\$authRequired = \$true/, "source-locked startup must fail closed instead of silently restarting Main-01");
assert.match(interactiveManager, /if \(\$NoPrimaryFallback -or \$primarySource\.Count -eq 0\)/, "NoPrimaryFallback must stop at the explicit interactive-auth-required boundary instead of silently using Primary");
assert.match(interactiveManager, /cdp-session-seed/, "interactive manager must record CDP source provisioning separately");
assert.match(interactiveManager, /primary-controlled-snapshot/, "interactive manager must record controlled Primary fallback separately");
assert.match(interactiveManager, /-Role\s+interactive/, "interactive manager must select interactive role explicitly");
assert.match(interactiveManager, /chat-swarm-classic-auth-seed\.mjs/, "interactive setup must use secure Session Seed");
assert.match(interactiveManager, /PrimaryPidBefore/, "live mutations must capture Main-01 PID before work");
assert.match(interactiveManager, /PrimaryPidAfter/, "live mutations must capture Main-01 PID after work");
assert.match(interactiveManager, /Main01Unchanged/, "non-Primary-restart paths must still expose unchanged-Primary evidence");
assert.match(interactiveManager, /PrimaryRestarted/, "controlled Primary fallback must report whether Main-01 restarted");
assert.match(interactiveManager, /PrimaryRestored/, "controlled Primary fallback must report verified Main-01 restoration");
assert.match(interactiveManager, /verified-existing-session/, "restart gate must accept a UI-verified independently authenticated Interactive session even when no Session Seed marker exists yet");
assert.match(interactiveManager, /interactive-auth-required/, "setup must keep an explicit cold-start auth-required fallback when no signed-in local source exists");
assert.match(interactiveManager, /source-locked/, "filesystem fallback must still classify the canonical Primary cookie lock explicitly");
assert.match(interactiveManager, /Write-SeedMarker[\s\S]*ProvisioningMode/, "restart gate must persist only a non-secret provisioning marker after verifying an existing signed-in Interactive session");
assert.doesNotMatch(interactiveManager, /chat-swarm-classic-controller\.ps1/, "secondary Mains must not enter Worker controller ownership");
assert.doesNotMatch(interactiveManager, /chat_swarm_join|Invoke-AutoJoin|-Action\s+autojoin/i, "secondary Mains must not invoke Worker swarm autojoin");

assert.match(sessionSource, /interactive[\s\S]*worker[\s\S]*primary/i, "source discovery must prefer Interactive CDP, then Worker CDP, then Primary");
assert.match(sessionSource, /9730/, "Interactive source discovery must use the dedicated Main CDP range");
assert.match(sessionSource, /9330/, "Worker source discovery must use the Worker CDP range");
assert.doesNotMatch(sessionSource, /probe\.composerDisabled/, "a signed-in Main or Worker remains a valid Session Seed source while its composer is temporarily disabled by active generation");
assert.doesNotMatch(sessionSource, /Network\.getAllCookies|Network\.setCookies/, "source discovery must not itself read or mutate cookie values");
assert.match(cdpSessionSeed, /allowlistedDomainsOnly:\s*true/, "CDP Session Seed must continue to restrict copied cookies to ChatGPT/OpenAI domains");
assert.match(cdpSessionSeed, /secretValuesLogged:\s*false/, "CDP Session Seed must remain no-secret-output");
assert.match(cdpSessionSeed, /settle-seconds/, "CDP Session Seed must include a bounded persistence-settle interval before first-use restart gates");
assert.match(cdpSessionSeed, /persistenceSettled,/, "CDP Session Seed must report whether the target stayed verified through the persistence-settle interval");

assert.match(primarySnapshot, /Stop-Process[\s\S]*OpenAI\.ChatGPT-Desktop|Stop-CanonicalPrimary/i, "controlled Primary fallback must explicitly stop only canonical Main-01");
assert.match(primarySnapshot, /PrimaryRestored/, "controlled Primary fallback must verify restored Main-01");
assert.match(primarySnapshot, /chat-swarm-classic-auth-seed\.mjs/, "controlled Primary fallback must reuse encrypted profile Session Seed helper");
assert.doesNotMatch(primarySnapshot, /OpenAI\.ChatGPT-Desktop\.Interactive\d|Worker\d/i, "controlled Primary fallback must not stop secondary Main or Worker packages");

assert.match(mainOrchestrator, /Find-FreeMainNumber/, "high-level Main orchestration must automatically choose a free Main number");
assert.match(mainOrchestrator, /show|restore|minimize|stop/i, "high-level Main orchestration must own user-facing window lifecycle actions");
assert.match(mainOrchestrator, /chat-classic-interactive-runtime\.ps1/, "high-level orchestration must delegate setup/start/stop to the Interactive manager");
assert.doesNotMatch(mainOrchestrator, /\$output\s*=\s*@\(& \$interactiveManager[\s\S]{0,260}\$LASTEXITCODE/, "PowerShell-to-PowerShell delegation must not use stale LASTEXITCODE as the child script success signal");

assert.match(authSeed, /better-sqlite3/, "Session Seed must use a consistent online SQLite snapshot");
assert.match(authSeed, /readonly:\s*true/, "Session Seed source must be read-only");
assert.match(authSeed, /secretValuesLogged:\s*false/, "Session Seed must not log raw auth values");
assert.match(authSeed, /source-locked/, "Session Seed must report canonical Primary cookie sharing locks as a machine-readable non-secret reason");
assert.match(authSeed, /ok:\s*false/, "Session Seed failures must be machine-readable for role-aware fallback handling");

assert.match(runtimeTools, /chat_main_runtime_open/, "MCP must expose one-command create/open for a free Interactive Main");
assert.match(runtimeTools, /chat_main_runtime_status/, "MCP must expose interactive runtime status");
assert.match(runtimeTools, /chat_main_runtime_setup/, "MCP must expose interactive runtime setup");
assert.match(runtimeTools, /chat_main_runtime_start/, "MCP must expose interactive runtime start");
assert.match(runtimeTools, /chat_main_runtime_authenticate/, "MCP must expose a bounded Interactive OAuth relay fallback for Primary cookie sharing locks");

assert.match(identityManager, /function Get-InteractivePackages/, "identity audit must discover secondary interactive packages separately from Workers");
assert.match(identityManager, /function Get-InteractiveIdentityRow/, "identity audit must validate Interactive package registration and manifest state");
assert.match(identityManager, /InteractiveIsolationSafe/, "identity snapshot must expose a dedicated Interactive isolation gate");
assert.match(identityManager, /Interactives\s*=\s*\$interactives/, "identity snapshot must report Interactive runtimes without merging them into Workers");
assert.doesNotMatch(identityManager, /Repair-InstalledInteractives/, "identity guard must never repair or recycle user-facing Interactive runtimes automatically");

assert.match(interactiveAuthRelay, /TargetAlias/, "OAuth relay must require an explicit secondary Main alias");
assert.match(interactiveAuthRelay, /auth\/open_in_desktop/, "OAuth relay must discover only the desktop-auth completion page");
assert.match(interactiveAuthRelay, /chatgpt:\/\/oauth_complete/, "OAuth relay must reconstruct the Windows ChatGPT desktop callback in memory");
assert.match(interactiveAuthRelay, /openai-sidetron/, "OAuth relay must allowlist the Sidetron auth callback path");
assert.match(interactiveAuthRelay, /\{0\}\{1\}\?code=\{2\}&state=\{3\}[\s\S]*-f\s+\$prefix/, "OAuth relay must build callback URLs with an interpolation-safe format string");
assert.doesNotMatch(interactiveAuthRelay, /"\$prefix\$path\?code=/, "OAuth relay must not use ambiguous PowerShell variable interpolation around query delimiters");
assert.doesNotMatch(interactiveAuthRelay, /Invoke-WebRequest/, "OAuth relay must not refetch the browser-bound completion page outside the authenticated browser session");
assert.match(interactiveAuthRelay, /Start-Process -FilePath \$TargetAlias/, "OAuth relay must bypass global protocol routing by launching the explicit target alias");
assert.match(interactiveAuthRelay, /chrome|msedge/i, "OAuth relay must inspect supported browser windows rather than one hard-coded Chrome process");
assert.match(interactiveAuthRelay, /SecretMaterialLogged\s*=\s*\$false/, "OAuth relay must attest that callback material is never logged");
assert.doesNotMatch(interactiveAuthRelay, /UserChoice|Set-ItemProperty|New-ItemProperty/, "OAuth relay must never rewrite the protected Windows default-protocol choice");
assert.doesNotMatch(interactiveAuthRelay, /Write-(?:Output|Host)[^\n]*\$callback|echo[^\n]*\$callback/i, "OAuth relay must never print callback material");
assert.match(bootstrap, /--login-only/, "CDP helper must support a bounded login-button action for Interactive auth relay");
assert.match(bootstrap, /--auth-back-only/, "CDP helper must support bounded recovery from an OAuthCallback error page");
assert.match(bootstrap, /--google-login-only/, "CDP helper must support a bounded Google-login action without filling credentials");
assert.match(bootstrap, /log in\|登入/i, "login-only action must target only the explicit login control");
assert.match(bootstrap, /go back\|返回/i, "auth-back action must target only the explicit error recovery control");
assert.match(bootstrap, /google/i, "Google-login action must target an explicit Google auth control");

assert.match(interactiveAuthLiveGate, /composer[\s\S]*loginVisible/, "live gate must require a real composer before treating an Interactive runtime as signed in");
assert.match(interactiveAuthLiveGate, /--auth-back-only/, "live gate must recover from OAuthCallback errors without restarting Main-02");
assert.match(interactiveAuthLiveGate, /--google-login-only/, "live gate must trigger the selected OAuth provider only after the relay watcher is armed");
assert.match(interactiveAuthLiveGate, /PollMilliseconds[^\n]*100|PollMilliseconds\s+100/, "live gate must use the low-latency relay polling path for fresh one-time callbacks");
assert.match(interactiveAuthLiveGate, /ValidateSet\("start",\s*"finish",\s*"full"\)/, "Interactive authentication must support non-blocking start/finish staging as well as the combined live gate");
assert.match(interactiveAuthLiveGate, /browser-auth-started/, "stage=start must return after opening browser authentication instead of blocking on user account selection");
assert.match(interactiveAuthLiveGate, /provisioningMode\s*=\s*"oauth-relay"/, "successful OAuth relay must persist only a non-secret provisioning marker");

assert.match(packageJson.version, /^0\.5\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "current DevSpace Ultra release metadata must remain on the v0.5 line");
const packageVersionPattern = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert.match(server, new RegExp(`name: "devspace",[\\s\\S]{0,160}version: "${packageVersionPattern}"`), "MCP server identity version must match package.json instead of lagging a prior release");
assert.ok(!packageJson.files.includes("!scripts/chat-swarm-classic-auth-seed.mjs"), "public package must include the no-secret Session Seed helper required by Interactive setup");
assert.doesNotMatch(gitIgnore, /^scripts\/chat-swarm-classic-auth-seed\.mjs$/m, "clean Git checkouts must include the production Session Seed helper");
assert.doesNotMatch(npmIgnore, /^scripts\/chat-swarm-classic-auth-seed\.mjs$/m, "npm packages must include the production Session Seed helper");
assert.match(gitIgnore, /^\.devspace-tmp\/$/m, "temporary live-gate capabilities must stay outside Git history");

console.log(JSON.stringify({ ok: true, gate: "interactive-runtime-static" }));
