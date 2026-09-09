#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { classifyEdgeConfig, deployCloudflareWorker, deployCloudflareWorkerVpc, ensureCloudflareTunnel, ensureVpcService, installFixedEdgeStartup, planDisableEdgeConfig, planFixedEdgeCandidateConfig, planFixedEdgeConfig, probeFixedEdge, resolveWranglerAuthEnv, startCloudflareTunnelDetached } from "./edge-cloudflare.js";
import { createCodexContextBridge } from "./codex-context-bridge.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { isLocalAgentProvider, loadLocalAgentProfiles, } from "./local-agent-profiles.js";
import { assertLocalAgentProviderAvailable, formatLocalAgentProviderAvailabilitySummary, } from "./local-agent-availability.js";
import { formatAvailableLocalAgentTargets, parseLocalAgentRunArgs, resolveLocalAgentTarget, } from "./local-agent-targets.js";
import { createLocalAgentStore } from "./local-agent-store.js";
import { ensureDevspaceDefaultSkills, generateOwnerToken, loadDevspaceFiles, resolveSubagentsFlag, writeDevspaceAuth, writeDevspaceConfig, } from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { shutdownHttpServer } from "./server-shutdown.js";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=22.19 <27";
async function main(argv) {
    assertSupportedNode();
    const [rawCommand, ...args] = argv;
    const command = normalizeCommand(rawCommand);
    switch (command) {
        case "setup":
            await runSetupCommand(args);
            return;
        case "serve":
            await ensureConfigured();
            await serve();
            return;
        case "init":
            await runInit({ force: args.includes("--force") });
            return;
        case "doctor":
            await runDoctor();
            return;
        case "config":
            runConfigCommand(args);
            return;
        case "edge":
            await runEdgeCommand(args);
            return;
        case "context":
            await runContextCommand(args);
            return;
        case "agents":
            await runAgentsCommand(args);
            return;
        case "help":
            printHelp();
            return;
        case "version":
            printVersion();
            return;
    }
}
function normalizeCommand(command) {
    if (!command || command === "serve" || command === "start")
        return "serve";
    if (command === "setup" || command === "init" || command === "doctor" || command === "config" || command === "edge" || command === "context" || command === "agents")
        return command;
    if (command === "help" || command === "--help" || command === "-h")
        return "help";
    if (command === "version" || command === "--version" || command === "-v")
        return "version";
    throw new Error(`Unknown command: ${command}`);
}

function optionValue(args, name) {
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length)
        return null;
    return String(args[index + 1]);
}

function optionValues(args, name) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === name && index + 1 < args.length)
            values.push(String(args[index + 1]));
    }
    return values;
}

async function runSetupCommand(args) {
    if (process.platform !== "win32") {
        prompts.log.warn("The integrated Stable Gateway + DuckDNS/Caddy setup is currently Windows-only.");
        await runInit({ force: args.includes("--force") });
        prompts.log.info("Use your own HTTPS reverse proxy, or run `devspace edge cloudflare setup` for the Cloudflare fallback.");
        return;
    }

    const files = loadDevspaceFiles();
    const nonInteractive = args.includes("--non-interactive");
    if (nonInteractive && (!optionValue(args, "--edge") || optionValues(args, "--root").length === 0)) {
        throw new Error("Non-interactive setup requires --edge <duckdns|cloudflare|local> and at least one --root <path>.");
    }

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootOptions = optionValues(args, "--root");
    const rootsAnswer = rootOptions.length
        ? rootOptions.join(",")
        : await textPrompt({
            message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
            placeholder: defaultRoots,
            defaultValue: defaultRoots,
            validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
        });
    const allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);

    const defaultGatewayPort = String(files.config.stableGatewayPort ?? files.config.port ?? 7678);
    const gatewayPortText = optionValue(args, "--gateway-port")
        ?? await textPrompt({
            message: `Which local Stable Gateway port should DevSpace use? Press Enter to use ${defaultGatewayPort}`,
            placeholder: defaultGatewayPort,
            defaultValue: defaultGatewayPort,
            validate: validatePort,
        });
    const gatewayPort = Number(gatewayPortText);

    let edge = optionValue(args, "--edge");
    if (!edge) {
        edge = await selectPrompt({
            message: "How should ChatGPT reach this computer?",
            options: [
                {
                    value: "duckdns",
                    label: "DuckDNS + Caddy (recommended)",
                    hint: "Direct DDNS route; no Worker request quota. Requires public IPv4 and router UPnP/port forwarding.",
                },
                {
                    value: "cloudflare",
                    label: "Cloudflare Worker + Tunnel fallback",
                    hint: "Works without inbound ports/UPnP. Workers Free currently allows 100,000 requests/day.",
                },
                {
                    value: "local",
                    label: "Local only",
                    hint: "Install the Stable Gateway now and configure a public HTTPS route later.",
                },
            ],
            initialValue: "duckdns",
        });
    }
    if (!["duckdns", "cloudflare", "local"].includes(edge)) {
        throw new Error("--edge must be duckdns, cloudflare, or local.");
    }

    let domain = optionValue(args, "--domain");
    if (edge === "duckdns" && !domain) {
        if (nonInteractive)
            throw new Error("Non-interactive DuckDNS setup requires --domain <name.duckdns.org>.");
        domain = await textPrompt({
            message: "DuckDNS hostname (for example devspace-example.duckdns.org)",
            placeholder: "devspace-example.duckdns.org",
            defaultValue: "",
            validate: validateDuckDnsDomain,
        });
    }
    if (domain)
        domain = normalizeDuckDnsDomain(domain);

    const stateDir = resolve(expandHomePath(files.config.stateDir
        ?? join(process.env.USERPROFILE || process.env.HOME || ".", ".local", "share", "devspace-ultra")));
    const localBaseUrl = `http://127.0.0.1:${gatewayPort}`;
    const selectedBaseUrl = edge === "duckdns" ? `https://${domain}` : files.config.publicBaseUrl ?? localBaseUrl;
    const config = {
        ...files.config,
        host: "127.0.0.1",
        port: gatewayPort,
        allowedRoots,
        publicBaseUrl: selectedBaseUrl,
        stateDir,
        toolMode: "ultra",
        pluginsEnabled: true,
        skillsEnabled: true,
        artifactsEnabled: true,
        subagents: files.config.subagents ?? true,
        stableGatewayPort: gatewayPort,
        stableGatewayPublicBaseUrl: selectedBaseUrl,
        stableGatewayStateDir: stateDir,
        stableGatewayCoreAPort: gatewayPort + 10,
        stableGatewayCoreBPort: gatewayPort + 11,
        stableGatewayCoreHeapProfile: "system",
        autoCompactEnabled: files.config.autoCompactEnabled === true,
        goalRoundRecoveryEnabled: files.config.goalRoundRecoveryEnabled === true,
    };
    const auth = {
        ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };
    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);
    ensureDevspaceDefaultSkills();

    prompts.intro("DevSpace Ultra one-command setup");
    prompts.log.info(`Config: ${configPath}`);
    prompts.log.info(`Stable Gateway: ${localBaseUrl}`);
    if (edge === "cloudflare") {
        prompts.log.warn("Cloudflare Workers Free currently allows 100,000 requests per day and 10 ms CPU time per invocation. DuckDNS/Caddy avoids that Worker request quota.");
    }

    const setupScript = fileURLToPath(new URL("../scripts/devspace-ultra-setup.ps1", import.meta.url));
    const powershellArgs = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", setupScript,
        "-Edge", edge,
        "-GatewayPort", String(gatewayPort),
        "-ConfigDir", files.dir,
        "-PackageRoot", resolve(fileURLToPath(new URL("..", import.meta.url))),
    ];
    const interfaceAlias = optionValue(args, "--interface");
    const workerName = optionValue(args, "--worker-name");
    if (domain)
        powershellArgs.push("-Domain", domain);
    if (interfaceAlias)
        powershellArgs.push("-InterfaceAlias", interfaceAlias);
    if (workerName)
        powershellArgs.push("-WorkerName", workerName);

    let exitCode = await runInherited("powershell.exe", powershellArgs);
    if (exitCode !== 0 && edge === "duckdns" && !nonInteractive) {
        const useCloudflare = await confirmPrompt({
            message: "DuckDNS direct ingress did not complete. Set up the Cloudflare fallback instead?",
            initialValue: true,
        });
        if (useCloudflare) {
            writeDevspaceConfig({ ...config, publicBaseUrl: localBaseUrl, stableGatewayPublicBaseUrl: localBaseUrl });
            const fallbackArgs = powershellArgs.map((value, index, values) => values[index - 1] === "-Edge" ? "cloudflare" : value);
            exitCode = await runInherited("powershell.exe", fallbackArgs);
            edge = "cloudflare";
        }
    }
    if (exitCode !== 0)
        throw new Error(`Windows setup failed with exit code ${exitCode}. Existing configuration and generated owner token were preserved for repair/retry.`);

    const refreshed = loadDevspaceFiles();
    const publicBaseUrl = refreshed.config.edgePublicBaseUrl ?? refreshed.config.publicBaseUrl ?? localBaseUrl;
    prompts.note([
        `Public MCP URL: ${publicBaseUrl.replace(/\/+$/, "")}/mcp`,
        `Local health: ${localBaseUrl}/healthz`,
        `Owner password is stored at: ${authPath}`,
        edge === "duckdns"
            ? "Ingress: DuckDNS + Caddy + router port mapping (primary path, no Cloudflare Worker request quota)."
            : edge === "cloudflare"
                ? "Ingress: Cloudflare Worker/VPC fallback. Workers Free currently allows 100,000 requests/day; paid-plan terms may differ."
                : "Ingress: local only; configure a public HTTPS route before adding DevSpace to ChatGPT.",
    ].join("\n"), "DevSpace Ultra configured");
    prompts.outro("Setup complete. The Stable Gateway will start automatically at Windows logon.");
}

function runInherited(command, args) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            stdio: "inherit",
            windowsHide: false,
            shell: false,
        });
        child.once("error", rejectPromise);
        child.once("exit", (code) => resolvePromise(Number(code ?? 1)));
    });
}
async function ensureConfigured() {
    const files = loadDevspaceFiles();
    if (files.configExists && files.authExists)
        return;
    if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN)
        return;
    if (!input.isTTY || !output.isTTY) {
        throw new Error([
            "DevSpace is not configured and this terminal is non-interactive.",
            "",
            "Run:",
            "  devspace init",
            "",
            "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
        ].join("\n"));
    }
    await runInit({ force: false });
}
async function runInit({ force }) {
    const files = loadDevspaceFiles();
    if (!force && files.configExists && files.authExists) {
        prompts.log.info(`DevSpace is already configured at ${files.dir}`);
        prompts.log.info("Run `devspace init --force` to update it.");
        return;
    }
    try {
        prompts.intro("DevSpace setup");
        const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
        const rootsAnswer = await textPrompt({
            message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
            placeholder: defaultRoots,
            defaultValue: defaultRoots,
            validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
        });
        const allowedRoots = rootsAnswer
            .split(",")
            .map((root) => resolve(expandHomePath(root.trim())))
            .filter(Boolean);
        const defaultPort = String(files.config.port ?? 7676);
        const portAnswer = await textPrompt({
            message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
            placeholder: defaultPort,
            defaultValue: defaultPort,
            validate: validatePort,
        });
        const port = Number(portAnswer);
        prompts.note([
            "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
            "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
            "Paste the public origin here, without /mcp.",
            "",
            "Example: https://your-tunnel-host.example.com",
        ].join("\n"), "Public URL required");
        const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
            message: files.config.publicBaseUrl
                ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
                : "What is the public base URL?",
            placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
            defaultValue: files.config.publicBaseUrl ?? "",
            validate: validateRequiredPublicBaseUrl,
        }));
        const config = {
            host: files.config.host ?? "127.0.0.1",
            port,
            allowedRoots,
            publicBaseUrl,
            subagents: resolveSubagentsFlag(files.config),
        };
        const auth = {
            ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
        };
        const configPath = writeDevspaceConfig(config);
        const authPath = writeDevspaceAuth(auth);
        const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];
        const lines = [
            `Config: ${configPath}`,
            `Auth: ${authPath}`,
            ...seededSkillPaths.map((path) => `Default skill: ${path}`),
            `Local MCP URL: http://${config.host}:${config.port}/mcp`,
            ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
        ];
        prompts.note(lines.join("\n"), "DevSpace configured");
        prompts.note([
            `Owner password: ${auth.ownerToken}`,
            "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
            `Stored at: ${authPath}`,
        ].join("\n"), "Owner password");
        prompts.outro("Run `devspace serve` to start the MCP server.");
    }
    catch (error) {
        if (error instanceof SetupCancelledError) {
            prompts.cancel("Setup cancelled");
            return;
        }
        throw error;
    }
}
async function serve() {
    const sqliteStatus = checkSqliteNative();
    if (sqliteStatus !== "ok") {
        throw new Error([
            "better-sqlite3 could not load for this Node runtime.",
            sqliteStatus,
            "",
            "Try reinstalling or rebuilding dependencies under the active Node version:",
            "  npm rebuild better-sqlite3",
        ].join("\n"));
    }
    const { createServer } = await import("./server.js");
    const config = loadConfig();
    const { app, close, localAgentProviders } = createServer(config);
    const httpServer = app.listen(config.port, config.host, () => {
        console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
        console.log(`public base url: ${config.publicBaseUrl}`);
        console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
        console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
        if (config.allowedHosts.includes("*")) {
            console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
        }
        console.log("auth: Owner password approval required");
        console.log(`logging: ${config.logging.level} ${config.logging.format}`);
        if (config.subagents) {
            console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
        }
    });
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        await shutdownHttpServer(httpServer, close);
        process.exit(0);
    };
    const handleShutdown = () => {
        void shutdown().catch((error) => {
            console.error("devspace shutdown failed", error);
            process.exit(1);
        });
    };
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
}
async function runDoctor() {
    const files = loadDevspaceFiles();
    console.log(`Config dir: ${files.dir}`);
    console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
    console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
    console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
    console.log(`Node ABI: ${process.versions.modules}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
    console.log(`Git: ${checkGitAvailable()}`);
    console.log(`Bash shell: ${checkBashShell()}`);
    console.log(`SQLite native dependency: ${checkSqliteNative()}`);
    try {
        const config = loadConfig();
        console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
        console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
        console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
        console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
        console.log(`Capability plugins: ${config.pluginsEnabled ? "enabled" : "disabled"}`);
        console.log(`Capability plugin directory: ${config.pluginsDir}`);
        console.log(`Capability registry: ${config.capabilityRegistryPath}`);
        console.log(`External capability roots: ${config.pluginPaths.length ? config.pluginPaths.join(", ") : "none"}`);
    }
    catch (error) {
        console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function runConfigCommand(args) {
    const [subcommand, key, ...rest] = args;
    const files = loadDevspaceFiles();
    if (!subcommand || subcommand === "get") {
        console.log(JSON.stringify(files.config, null, 2));
        return;
    }
    if (subcommand !== "set") {
        throw new Error(`Unknown config command: ${subcommand}`);
    }
    if (key !== "publicBaseUrl") {
        throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
    }
    const value = rest.join(" ").trim();
    if (!value) {
        throw new Error("Missing publicBaseUrl value.");
    }
    writeDevspaceConfig({
        ...files.config,
        publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
    });
    console.log(`Updated ${files.configPath}`);
}
async function runEdgeCommand(args) {
    const [subcommand, providerOrAction, ...rest] = args;
    const files = loadDevspaceFiles();
    if (!subcommand || subcommand === "status") {
        const classification = classifyEdgeConfig(files.config);
        let probe = null;
        let probeError = null;
        if (classification.mode === "fixed" && files.config.edgePublicBaseUrl) {
            try {
                probe = await probeFixedEdge(files.config.edgePublicBaseUrl);
            }
            catch (error) {
                probeError = error instanceof Error ? error.message : String(error);
            }
        }
        console.log(JSON.stringify({
            ok: true,
            ...classification,
            originBaseUrl: files.config.edgeOriginBaseUrl ?? null,
            probe,
            probeError,
        }, null, 2));
        return;
    }
    if (subcommand === "disable") {
        const next = planDisableEdgeConfig(files.config);
        writeDevspaceConfig(next);
        console.log(JSON.stringify({
            ok: true,
            state: "disabled",
            publicBaseUrl: next.publicBaseUrl,
            restartRequired: false,
        }, null, 2));
        return;
    }
    if (subcommand !== "cloudflare") {
        throw new Error(`Unknown edge command: ${subcommand}`);
    }
    if (providerOrAction === "verify") {
        const publicBaseUrl = files.config.edgePublicBaseUrl ?? files.config.publicBaseUrl;
        if (!publicBaseUrl) throw new Error("No fixed edge public URL is configured.");
        const probe = await probeFixedEdge(publicBaseUrl);
        console.log(JSON.stringify(probe, null, 2));
        if (!probe.ok) process.exitCode = 2;
        return;
    }
    if (providerOrAction !== "setup") {
        throw new Error("Usage: devspace edge cloudflare setup [--name <worker-name>] [--tunnel-name <name>] [--service-name <name>] [--transport workers-vpc|public-origin] [--origin <https-origin>] [--backend-port <port>] [--fixed-state-dir <path>]");
    }
    const option = (name) => {
        const index = rest.indexOf(name);
        if (index < 0 || index + 1 >= rest.length) return null;
        return rest[index + 1];
    };
    const workerName = option("--name") ?? "devspace-ultra-mcp-edge";
    const transport = option("--transport") ?? "workers-vpc";
    const backendPort = Number(option("--backend-port") ?? files.config.edgeBackendPort ?? 7677);
    const fixedStateDir = option("--fixed-state-dir") ?? files.config.edgeFixedStateDir ?? join(process.env.USERPROFILE || process.env.HOME || ".", ".local", "share", "devspace-fixed");
    const auth = await resolveWranglerAuthEnv(process.env);

    let deployment;
    let next;
    let tunnel = null;
    let vpcService = null;
    let tunnelProcess = null;

    if (transport === "workers-vpc") {
        const tunnelName = option("--tunnel-name") ?? files.config.edgeTunnelName ?? "devspace-ultra-origin";
        const serviceName = option("--service-name") ?? files.config.edgeVpcServiceName ?? "devspace-ultra-fixed";
        tunnel = await ensureCloudflareTunnel({ name: tunnelName, env: auth.env });
        vpcService = await ensureVpcService({
            name: serviceName,
            tunnelId: tunnel.id,
            port: backendPort,
            env: auth.env,
        });
        tunnelProcess = startCloudflareTunnelDetached(tunnel.id, { env: auth.env });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
        deployment = await deployCloudflareWorkerVpc({
            serviceId: vpcService.id,
            workerName,
            env: auth.env,
        });
        next = planFixedEdgeCandidateConfig(files.config, {
            publicBaseUrl: deployment.publicBaseUrl,
            workerName: deployment.workerName,
            transportMode: "workers-vpc",
            tunnelId: tunnel.id,
            tunnelName: tunnel.name,
            vpcServiceId: vpcService.id,
            vpcServiceName: vpcService.name,
            backendPort,
            fixedStateDir,
        });
    }
    else if (transport === "public-origin") {
        const originBaseUrl = option("--origin") ?? files.config.edgeOriginBaseUrl ?? files.config.publicBaseUrl;
        if (!originBaseUrl) throw new Error("public-origin transport requires --origin <https-origin> or an existing publicBaseUrl.");
        deployment = await deployCloudflareWorker({ originBaseUrl, workerName, env: auth.env });
        next = planFixedEdgeCandidateConfig(files.config, {
            originBaseUrl: deployment.originBaseUrl,
            publicBaseUrl: deployment.publicBaseUrl,
            workerName: deployment.workerName,
            transportMode: "public-origin",
            backendPort,
            fixedStateDir,
        });
    }
    else {
        throw new Error(`Unsupported Cloudflare edge transport: ${transport}`);
    }

    let startup = null;
    writeDevspaceConfig(next);
    try {
        if (transport === "workers-vpc") {
            startup = await installFixedEdgeStartup();
        }
        const transportHealth = await fetch(`${deployment.publicBaseUrl}/healthz`, { redirect: "manual", cache: "no-store" });
        if (!transportHealth.ok) {
            throw new Error(`Deployed Worker could not reach the isolated fixed backend health endpoint (HTTP ${transportHealth.status}).`);
        }
        const transportMcp = await fetch(`${deployment.publicBaseUrl}/mcp`, { redirect: "manual", cache: "no-store" });
        if (transportMcp.status !== 401 || !/resource_metadata=/i.test(transportMcp.headers.get("www-authenticate") || "")) {
            throw new Error(`Deployed Worker did not preserve the DevSpace MCP OAuth challenge (HTTP ${transportMcp.status}).`);
        }
    }
    catch (error) {
        writeDevspaceConfig(files.config);
        throw new Error(`Fixed edge setup failed after isolated deployment; previous DevSpace control config was restored. ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify({
        ok: true,
        state: "deployed-configured",
        transport,
        authMode: auth.mode,
        workerName: deployment.workerName,
        publicBaseUrl: deployment.publicBaseUrl,
        mcpUrl: `${deployment.publicBaseUrl}/mcp`,
        tunnelId: tunnel?.id ?? null,
        tunnelName: tunnel?.name ?? null,
        vpcServiceId: vpcService?.id ?? null,
        vpcServiceName: vpcService?.name ?? null,
        tunnelProcessStarted: Boolean(tunnelProcess?.started),
        startupInstalled: transport === "workers-vpc" ? Boolean(startup?.Ok ?? startup?.ok) : null,
        startupTaskName: startup?.TaskName ?? null,
        backendPort,
        fixedStateDir,
        controlIdentityPreserved: true,
        restartRequired: false,
        next: "Fixed backend is isolated and persistent; the existing control backend identity was preserved. Run `devspace edge cloudflare verify`."
    }, null, 2));
}
async function runContextCommand(args) {
    const [source, action = "list", ...rest] = args;
    if (source !== "codex") {
        throw new Error("Usage: devspace context codex <list|import|latest> [options]");
    }
    const option = (name) => {
        const index = rest.indexOf(name);
        if (index < 0 || index + 1 >= rest.length) return null;
        return rest[index + 1];
    };
    const flag = (name) => rest.includes(name);
    const config = loadConfig();
    let bridge;
    try {
        bridge = createCodexContextBridge({ codexDir: config.agentDir, stateDir: config.stateDir });
        if (action === "list") {
            const threads = bridge.listThreads({
                query: option("--query") ?? undefined,
                projectPath: option("--project") ?? undefined,
                includeArchived: flag("--include-archived"),
                limit: option("--limit") ? Number(option("--limit")) : 50,
            });
            console.log(JSON.stringify({ ok: true, count: threads.length, threads }, null, 2));
            return;
        }
        if (action === "import") {
            const result = await bridge.importThread({
                threadId: option("--thread") ?? undefined,
                query: option("--query") ?? undefined,
                projectPath: option("--project") ?? undefined,
                latest: flag("--latest"),
                includeArchived: flag("--include-archived") || Boolean(option("--thread")),
                maxChars: option("--max-chars") ? Number(option("--max-chars")) : undefined,
                maxMessages: option("--max-messages") ? Number(option("--max-messages")) : undefined,
                persist: !flag("--no-persist"),
            });
            console.log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exitCode = 2;
            return;
        }
        if (action === "latest") {
            const projectPath = option("--project");
            if (!projectPath) throw new Error("`devspace context codex latest` requires --project <path>.");
            const result = await bridge.importThread({
                projectPath,
                latest: true,
                includeArchived: flag("--include-archived"),
                persist: !flag("--no-persist"),
            });
            console.log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exitCode = 2;
            return;
        }
        throw new Error(`Unknown Codex context command: ${action}`);
    }
    finally {
        bridge?.close();
    }
}
function printHelp() {
    console.log([
        "DevSpace",
        "",
        "Usage:",
        "  devspace                 Run first-time setup if needed, then start the server",
        "  devspace setup           One-command Windows setup; DuckDNS+Caddy is primary, Cloudflare is fallback",
        "    --edge duckdns --domain <name.duckdns.org> [--root <path>]",
        "    --edge cloudflare [--root <path>]",
        "  devspace serve           Start the server",
        "  devspace init            Create or update ~/.devspace/config.json and auth.json",
        "  devspace doctor          Show config, runtime, and native dependency status",
        "  devspace config get      Print persisted config",
        "  devspace config set publicBaseUrl <url|null>",
        "  devspace edge status     Inspect fixed public MCP edge state",
        "  devspace edge cloudflare setup [--name <worker-name>]  # fixed Worker + Workers VPC by default",
        "  devspace edge cloudflare verify",
        "  devspace edge disable",
        "  devspace context codex list [--query <text>] [--project <path>]",
        "  devspace context codex import --thread <id>",
        "  devspace context codex latest --project <path>",
        "  devspace agents ls       List subagent sessions",
        "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
        "  devspace agents show <id>",
        "  devspace -v, --version   Print the installed version",
        "",
        "For temporary tunnels:",
        "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"));
}
async function runAgentsCommand(args) {
    const [subcommand, ...rest] = args;
    switch (subcommand) {
        case "ls":
        case "list":
            await runAgentsList();
            return;
        case "run":
            await runAgentsRun(rest);
            return;
        case "show":
            await runAgentsShow(rest);
            return;
        case "__worker":
            await runAgentsWorker(rest);
            return;
        case undefined:
        case "help":
        case "--help":
        case "-h":
            printAgentsHelp();
            return;
        default:
            throw new Error(`Unknown agents command: ${subcommand}`);
    }
}
async function runAgentsList() {
    const config = loadConfig();
    const store = createLocalAgentStore(config);
    const agents = store.list(resolveCurrentWorkspaceScope());
    if (agents.length === 0) {
        console.log("No subagent sessions found for this workspace.");
        return;
    }
    for (const agent of agents) {
        console.log(formatAgentLine(agent));
    }
}
async function runAgentsRun(args) {
    const parsed = parseLocalAgentRunArgs(args);
    const config = loadConfig();
    const workspaceRoot = resolveCurrentWorkspaceRoot();
    const store = createLocalAgentStore(config);
    const existing = store.get(parsed.target);
    if (existing) {
        if (!isLocalAgentProvider(existing.provider)) {
            throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
        }
        assertLocalAgentProviderAvailable(existing.provider);
        const promptFile = writeAgentPromptFile(parsed.prompt);
        store.update(existing.id, {
            status: "starting",
            model: parsed.model ?? existing.model,
            thinking: parsed.thinking ?? existing.thinking,
            latestResponse: undefined,
            error: undefined,
        });
        spawnAgentWorker(existing.id, promptFile);
        console.log(formatAgentLine({
            ...existing,
            status: "running",
            model: parsed.model ?? existing.model,
            thinking: parsed.thinking ?? existing.thinking,
        }));
        return;
    }
    const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
    const target = resolveLocalAgentTarget(parsed.target, profiles, parsed.model, parsed.thinking);
    if (!target) {
        throw new Error(`Unknown subagent profile, provider, or id: ${parsed.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`);
    }
    assertLocalAgentProviderAvailable(target.provider);
    const promptFile = writeAgentPromptFile(parsed.prompt);
    const record = store.create({
        workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
        workspaceRoot,
        profileName: target.name,
        provider: target.provider,
        model: target.model,
        thinking: target.thinking,
    });
    spawnAgentWorker(record.id, promptFile);
    console.log(formatAgentLine({ ...record, status: "running" }));
}
async function runAgentsShow(args) {
    const [id] = args;
    if (!id)
        throw new Error("Usage: devspace agents show <id>");
    const config = loadConfig();
    const store = createLocalAgentStore(config);
    let record = store.get(id);
    if (!record)
        throw new Error(`Unknown subagent id: ${id}`);
    const deadline = Date.now() + 15_000;
    while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
        await sleep(500);
        record = store.get(id) ?? record;
    }
    console.log(formatAgentLine(record));
    if (record.latestResponse) {
        console.log(record.latestResponse);
        return;
    }
    if (record.error) {
        console.log(record.error);
        return;
    }
    if (record.status === "starting" || record.status === "running") {
        console.log(`No final response yet. Call \`devspace agents show ${record.id}\` again later.`);
    }
}
async function runAgentsWorker(args) {
    const [id, promptFileFlag, promptFile] = args;
    if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
        throw new Error("Usage: devspace agents __worker <id> --prompt-file <path>");
    }
    const config = loadConfig();
    const store = createLocalAgentStore(config);
    const record = store.get(id);
    if (!record)
        throw new Error(`Unknown subagent id: ${id}`);
    store.update(record.id, { status: "running", error: undefined });
    try {
        const profiles = await loadLocalAgentProfiles(config, record.workspaceRoot);
        const profile = profiles.find((candidate) => candidate.name === record.profileName);
        const prompt = await readFile(promptFile, "utf8");
        const result = profile
            ? await runLocalAgentProfile(profile, record, prompt)
            : await runRawLocalAgentProvider(record, prompt);
        store.update(record.id, {
            providerSessionId: result.providerSessionId ?? undefined,
            status: "idle",
            latestResponse: result.finalResponse,
            error: undefined,
        });
    }
    catch (error) {
        store.update(record.id, {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
async function runLocalAgentProfile(profile, record, prompt) {
    const body = profile.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return runLocalAgentProvider(profile.provider, {
        prompt: fullPrompt,
        workspace: record.workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: "allowed",
        model: record.model ?? profile.model,
        thinking: record.thinking ?? profile.thinking,
    });
}
async function runRawLocalAgentProvider(record, prompt) {
    if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
        throw new Error(`Subagent profile not found: ${record.profileName}`);
    }
    return runLocalAgentProvider(record.provider, {
        prompt,
        workspace: record.workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: "allowed",
        model: record.model,
        thinking: record.thinking,
    });
}
function spawnAgentWorker(agentId, promptFile) {
    const child = spawn(process.execPath, [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "agents",
        "__worker",
        agentId,
        "--prompt-file",
        promptFile,
    ], {
        detached: true,
        stdio: "ignore",
        env: process.env,
    });
    child.unref();
}
function writeAgentPromptFile(prompt) {
    const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const filePath = join(directory, "prompt.txt");
    writeFileSync(filePath, prompt, { mode: 0o600 });
    return filePath;
}
function resolveCurrentWorkspaceRoot() {
    return resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
}
function resolveCurrentWorkspaceScope() {
    return {
        workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
        workspaceRoot: resolveCurrentWorkspaceRoot(),
    };
}
function formatAgentLine(agent) {
    const model = agent.model ? ` ${agent.model}` : "";
    const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
    return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}
function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
function printAgentsHelp() {
    console.log([
        "DevSpace agents",
        "",
        "Usage:",
        "  devspace agents ls",
        "  devspace agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
        "  devspace agents show <id>",
    ].join("\n"));
}
function printVersion() {
    const packageJson = require("../package.json");
    if (typeof packageJson.version !== "string") {
        throw new Error("Unable to read DevSpace package version.");
    }
    console.log(packageJson.version);
}
function normalizeOptionalPublicBaseUrl(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null" || trimmed === "none")
        return null;
    return normalizePublicBaseUrl(trimmed);
}
function normalizePublicBaseUrl(value) {
    const trimmed = value.trim();
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
}
async function textPrompt(options) {
    const result = await prompts.text({
        ...options,
        validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
    });
    if (prompts.isCancel(result))
        throw new SetupCancelledError();
    const value = String(result).trim();
    return value || options.defaultValue;
}
async function selectPrompt(options) {
    const result = await prompts.select(options);
    if (prompts.isCancel(result))
        throw new SetupCancelledError();
    return String(result);
}
async function confirmPrompt(options) {
    const result = await prompts.confirm(options);
    if (prompts.isCancel(result))
        throw new SetupCancelledError();
    return result === true;
}
function normalizeDuckDnsDomain(value) {
    const domain = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.duckdns\.org$/.test(domain))
        throw new Error("DuckDNS hostname must look like devspace-example.duckdns.org.");
    return domain;
}
function validateDuckDnsDomain(value) {
    try {
        normalizeDuckDnsDomain(value);
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
function validatePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535
        ? undefined
        : "Enter a port between 1 and 65535.";
}
function validateRequiredPublicBaseUrl(value) {
    const trimmed = value?.trim() ?? "";
    if (!trimmed)
        return "Enter the public URL from your tunnel or reverse proxy.";
    if (trimmed.endsWith("/mcp"))
        return "Enter the base URL only, without /mcp.";
    return validatePublicBaseUrl(trimmed);
}
function validatePublicBaseUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? undefined
            : "Use an http or https URL.";
    }
    catch {
        return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
    }
}
function assertSupportedNode() {
    if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE))
        return;
    throw new Error([
        `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
        `Current Node: ${process.version}`,
        "",
        "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"));
}
function nodeVersionStatus() {
    return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
        ? `supported ${SUPPORTED_NODE_RANGE}`
        : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}
class SetupCancelledError extends Error {
}
function checkSqliteNative() {
    try {
        const Database = require("better-sqlite3");
        const db = new Database(":memory:");
        db.close();
        return "ok";
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
function checkGitAvailable() {
    try {
        const { execFileSync } = require("node:child_process");
        return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `unavailable (${message})`;
    }
}
function checkBashShell() {
    try {
        const { shell, args } = getShellConfig();
        return `${shell} ${args.join(" ")}`;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `unavailable (${message})`;
    }
}
main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
