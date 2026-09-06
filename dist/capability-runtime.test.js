import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CapabilityRuntime,
  installedCapabilitySkillPaths,
  registerCapabilityTools,
} from "./capability-runtime.js";

async function makeFixtureSource(root) {
  const source = join(root, "fixture-source");
  await mkdir(join(source, "skills", "powermem-like"), { recursive: true });
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, ".codex-plugin"), { recursive: true });
  await mkdir(join(source, "claude-commands"), { recursive: true });
  await mkdir(join(source, "claude-agents"), { recursive: true });
  await mkdir(join(source, "hooks"), { recursive: true });
  await mkdir(join(source, "config"), { recursive: true });
  await writeFile(join(source, "devspace-plugin.json"), JSON.stringify({
    id: "fixture-memory",
    name: "Fixture Memory Capability",
    version: "1.2.3",
    description: "Fixture covering skills, MCP, instructions, and command tools.",
    skills: ["skills"],
    mcpServers: {
      memory: {
        command: process.execPath,
        args: ["fixture-mcp-server.mjs"],
        cwd: ".",
        env: { CAP_FIXTURE_SECRET: "${CAP_FIXTURE_SECRET}" },
        requiredEnv: ["CAP_FIXTURE_SECRET"],
      },
    },
    tools: [
      {
        name: "echo-json",
        description: "Echo JSON through a declared local command tool.",
        command: process.execPath,
        args: ["fixture-command.mjs"],
        cwd: ".",
        input: "json-stdin",
      },
    ],
  }, null, 2));
  await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "fixture-memory",
    version: "1.2.3",
    description: "Claude-style plugin metadata fixture.",
    commands: "./claude-commands",
    agents: "./claude-agents",
    hooks: "./hooks/hooks.json",
    mcpServers: "./claude.mcp.json"
  }, null, 2));
  await writeFile(join(source, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "fixture-memory-codex",
    version: "4.5.6",
    description: "Codex-style plugin metadata fixture.",
    skills: "./skills/",
    apps: "./.app.json",
    mcpServers: "./config/mcp-mode.mcp.json",
    hooks: ["./hooks/codex-session.json", "./hooks/codex-post-tool.json"],
    bundledContentVariant: "test-variant",
    interface: {
      displayName: "Fixture Codex Plugin",
      shortDescription: "Codex compatibility fixture",
      longDescription: "Fixture validating Codex plugin skills, app dependencies, MCP profiles, hooks, and interface metadata.",
      developerName: "DevSpace Test",
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
      websiteURL: "https://example.invalid/fixture",
      defaultPrompt: ["Run the fixture"],
      brandColor: "#123456"
    }
  }, null, 2));
  await writeFile(join(source, ".app.json"), JSON.stringify({ apps: { fixture: { id: "connector_fixture_test" } } }, null, 2));
  await writeFile(join(source, "hooks", "codex-session.json"), JSON.stringify({ hooks: { SessionStart: [] } }, null, 2));
  await writeFile(join(source, "hooks", "codex-post-tool.json"), JSON.stringify({ hooks: { PostToolUse: [] } }, null, 2));
  await writeFile(join(source, "claude-commands", "remember.md"), "# Remember command\nUse the memory capability.\n");
  await writeFile(join(source, "claude-agents", "memory-reviewer.md"), "# Memory reviewer\nReview stored memory.\n");
  await writeFile(join(source, "hooks", "hooks.json"), JSON.stringify({ SessionStart: [] }, null, 2));
  await writeFile(join(source, "claude.mcp.json"), JSON.stringify({
    mcpServers: {
      "claude-memory": { command: process.execPath, args: ["fixture-mcp-server.mjs"], cwd: ".", requiredEnv: ["CAP_FIXTURE_SECRET"] }
    }
  }, null, 2));
  await writeFile(join(source, "config", "mcp-mode.mcp.json"), JSON.stringify({
    mcpServers: {
      "profile-memory": { command: process.execPath, args: ["fixture-mcp-server.mjs"], cwd: ".", requiredEnv: ["CAP_FIXTURE_SECRET"] }
    }
  }, null, 2));
  await writeFile(join(source, "server.json"), JSON.stringify({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.fixture/memory",
    version: "1.0.0",
    description: "Official MCP Registry server.json compatibility fixture.",
    remotes: [
      {
        type: "streamable-http",
        url: "https://{tenant}.invalid.example/mcp",
        variables: { tenant: { description: "Tenant", isRequired: true } },
        headers: [{ name: "X-API-Key", description: "API key", isRequired: true, isSecret: true }]
      },
      {
        type: "streamable-http",
        url: "file:///tmp/not-a-remote-mcp"
      }
    ],
    packages: [{ registryType: "nuget", identifier: "Fixture.Memory.Mcp", version: "1.0.0", transport: { type: "stdio" } }],
  }, null, 2));
  await writeFile(join(source, "AGENTS.md"), "# Fixture plugin instructions\nUse memory carefully.\n");
  await writeFile(join(source, "skills", "powermem-like", "SKILL.md"), `---\nname: powermem-like\ndescription: Reusable test memory workflow.\n---\n# Memory skill\nUse the MCP memory tool.\n`);
  await writeFile(join(source, "fixture-command.mjs"), `let input=''; for await (const chunk of process.stdin) input += chunk; const value = input ? JSON.parse(input) : {}; process.stdout.write(JSON.stringify({echo:value, source:'command-tool'}));`);
  const mcpServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdioServerModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodModule = import.meta.resolve("zod/v4");
  await writeFile(join(source, "fixture-mcp-server.mjs"), `import { McpServer } from ${JSON.stringify(mcpServerModule)};\nimport { StdioServerTransport } from ${JSON.stringify(stdioServerModule)};\nimport * as z from ${JSON.stringify(zodModule)};\nconst server = new McpServer({name:'fixture-memory', version:'1.0.0'});\nserver.registerTool('remember', {description:'Store a test memory', inputSchema:{text:z.string()}}, async ({text}) => ({content:[{type:'text', text:'stored:'+text}], structuredContent:{stored:text, secretPresent:Boolean(process.env.CAP_FIXTURE_SECRET), instanceMarker:process.env.CAP_INSTANCE_MARKER||null}}));\nserver.registerResource('fixture-memory-resource', 'memory://fixture/status', {description:'Fixture memory status', mimeType:'text/plain'}, async (uri) => ({contents:[{uri:String(uri), mimeType:'text/plain', text:'fixture-resource-ok'}]}));\nserver.registerPrompt('memory-review', {description:'Review a memory topic', argsSchema:{topic:z.string()}}, async ({topic}) => ({messages:[{role:'user', content:{type:'text', text:'review-memory:'+topic}}]}));\nawait server.connect(new StdioServerTransport());\n`);
  return source;
}

function fakeServer(registrations) {
  return {
    registerTool(name, definition, handler) {
      registrations.push({ name, definition, handler });
    },
  };
}

async function connectCapabilityMcpSession(runtime, label) {
  const server = new McpServer({ name: `capability-test-server-${label}`, version: "0.3.0-dev" });
  registerCapabilityTools(server, runtime);
  const client = new Client({ name: `capability-test-client-${label}`, version: "0.3.0-dev" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), "devspace-capability-runtime-"));
  const pluginsDir = join(root, "plugins");
  const registryPath = join(pluginsDir, "registry.json");
  const source = await makeFixtureSource(root);
  process.env.CAP_FIXTURE_SECRET = "fixture-secret-not-for-registry";
  const runtime = new CapabilityRuntime({
    enabled: true,
    pluginsDir,
    registryPath,
    pluginPaths: [],
  });
  try {
    await runtime.ready;
    await assert.rejects(
      () => runtime.install({ source: "https://user:secret@github.com/example/private-plugin.git" }),
      /embedded credentials/,
    );
    await assert.rejects(
      () => runtime.install({ source: "https://github.com/example/plugin.git?token=secret" }),
      /query strings or fragments/,
    );

    const installed = await runtime.install({ source, enable: false, trust: false });
    assert.equal(installed.plugin.id, "fixture-memory");
    assert.equal(installed.plugin.enabled, false);
    assert.equal(installed.plugin.trusted, false);
    assert.deepEqual(installed.plugin.detectedFormats.sort(), ["agent-instructions", "agent-skills", "claude-agents", "claude-commands", "claude-hooks-metadata", "claude-plugin", "codex-app-dependencies", "codex-bundled-content-metadata", "codex-hooks-metadata", "codex-interface-metadata", "codex-plugin", "command-tools", "devspace-plugin", "mcp", "mcp-registry-server-json", "nested-mcp-profiles"].sort());
    assert.equal(installed.plugin.skills[0].name, "powermem-like");
    assert.equal(installed.plugin.mcpServers.some((server) => server.id === "memory"), true);
    assert.equal(installed.plugin.mcpServers.some((server) => server.id === "io.github.fixture/memory:package-1" && server.status === "not-probed"), true);
    const registryRemote = installed.plugin.mcpServers.find((server) => server.id === "io.github.fixture/memory:remote-1");
    assert.ok(registryRemote);
    assert.equal(registryRemote.requiredEnv.some((name) => name.endsWith("_VAR_TENANT")), true);
    assert.equal(registryRemote.requiredEnv.some((name) => name.endsWith("_HEADER_X_API_KEY")), true);
    assert.equal(installed.plugin.tools[0].name, "echo-json");
    assert.deepEqual(installed.plugin.claudeCommands.map((item) => item.path), ["claude-commands/remember.md"]);
    assert.deepEqual(installed.plugin.claudeAgents.map((item) => item.path), ["claude-agents/memory-reviewer.md"]);
    assert.deepEqual(installed.plugin.claudeHooks.map((item) => item.path), ["hooks/hooks.json"]);
    assert.deepEqual(installed.plugin.codexHooks.map((item) => item.path).sort(), ["hooks/codex-post-tool.json", "hooks/codex-session.json"].sort());
    assert.equal(installed.plugin.codexApps.length, 1);
    assert.deepEqual(installed.plugin.codexApps[0], {
      name: "fixture",
      id: "connector_fixture_test",
      path: ".app.json",
      pluginRoot: "",
      platformManaged: true,
      executableByDevSpace: false,
    });
    assert.equal(installed.plugin.codexInterfaces[0].displayName, "Fixture Codex Plugin");
    assert.deepEqual(installed.plugin.codexInterfaces[0].capabilities, ["Read", "Write"]);
    assert.deepEqual(installed.plugin.bundledContentVariants, [{ pluginRoot: "", value: "test-variant" }]);
    assert.equal(installed.plugin.mcpServers.some((server) => server.id === "claude-memory"), true);
    assert.equal(installed.plugin.mcpServers.some((server) => server.id === "profile:config/mcp-mode::profile-memory"), true);

    await assert.rejects(() => runtime.setEnabled("fixture-memory", true), /explicitly trusted/);
    const enabled = await runtime.setEnabled("fixture-memory", true, { trust: true });
    assert.equal(enabled.plugin.enabled, true);
    assert.equal(enabled.plugin.trusted, true);

    const skillPaths = installedCapabilitySkillPaths({
      pluginsEnabled: true,
      capabilityRegistryPath: registryPath,
      pluginPaths: [],
    });
    assert.equal(skillPaths.length, 1);
    assert.match(skillPaths[0].replace(/\\/g, "/"), /fixture-memory\/skills\/powermem-like$/);

    const instructions = await runtime.readResource("fixture-memory", "AGENTS.md");
    assert.match(instructions.content, /Fixture plugin instructions/);
    await assert.rejects(() => runtime.readResource("fixture-memory", "../outside.txt"), /escapes plugin root/);
    const outsideDir = join(root, "outside-resource");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "must-not-cross-plugin-root");
    await symlink(outsideDir, join(installed.plugin.installDir, "escape-link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => runtime.readResource("fixture-memory", "escape-link/secret.txt"),
      /symbolic link/,
    );

    const [sharedMcpA, sharedMcpB, sharedMcpC] = await Promise.all([
      runtime.getMcpClient("fixture-memory", "memory"),
      runtime.getMcpClient("fixture-memory", "memory"),
      runtime.getMcpClient("fixture-memory", "memory"),
    ]);
    assert.equal(sharedMcpA, sharedMcpB);
    assert.equal(sharedMcpB, sharedMcpC);
    await runtime.refresh({ pluginId: "fixture-memory", probeMcp: false });
    const refreshedMcp = await runtime.getMcpClient("fixture-memory", "memory");
    assert.notEqual(refreshedMcp, sharedMcpA);

    await runtime.closeClientKey("fixture-memory::memory");
    let timeoutOptions = null;
    let timeoutClientClosed = 0;
    let timeoutTransportClosed = 0;
    runtime.mcpClients.set("fixture-memory::memory", {
      client: { async close() { timeoutClientClosed += 1; } },
      transport: { async close() { timeoutTransportClosed += 1; } },
      definition: {},
    });
    await assert.rejects(
      () => runtime.executeMcpRequest("fixture-memory", "memory", undefined, async (_client, options) => {
        timeoutOptions = options;
        const error = new Error("Request timed out");
        error.code = -32001;
        throw error;
      }),
      /timed out/i,
    );
    assert.equal(timeoutOptions.timeout, 60_000, "MCP calls must use the SDK-native request timeout");
    assert.equal(timeoutOptions.maxTotalTimeout, 60_000, "MCP calls must bound total request lifetime as well");
    assert.equal(timeoutClientClosed, 1, "request timeout must invalidate the pooled MCP client");
    assert.equal(timeoutTransportClosed, 1, "request timeout must close the pooled MCP transport");
    assert.equal(runtime.mcpClients.has("fixture-memory::memory"), false, "timed-out pooled client must be removed so the next call reconnects cleanly");
    const recoveredMcp = await runtime.getMcpClient("fixture-memory", "memory");
    assert.notEqual(recoveredMcp, refreshedMcp, "a timed-out MCP client must not be reused");

    const instanceA = await runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-a",
      ownerLabel: "agent-A",
      env: { CAP_INSTANCE_MARKER: "A" },
      leaseSeconds: 300,
    });
    const instanceB = await runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-b",
      ownerLabel: "agent-B",
      env: { CAP_INSTANCE_MARKER: "B" },
      leaseSeconds: 300,
    });
    await assert.rejects(() => runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-a",
      ownerLabel: "competing-agent",
      env: {},
    }), /already claimed/);
    const [instanceClientA, instanceClientB] = await Promise.all([
      runtime.getMcpClient("fixture-memory", "memory", instanceA.instanceToken),
      runtime.getMcpClient("fixture-memory", "memory", instanceB.instanceToken),
    ]);
    assert.notEqual(instanceClientA, instanceClientB);
    assert.notEqual(instanceClientA, refreshedMcp);
    const [instanceCallA, instanceCallB] = await Promise.all([
      runtime.call({ pluginId: "fixture-memory", kind: "mcp", serverId: "memory", instanceToken: instanceA.instanceToken, toolName: "remember", arguments: { text: "A" } }),
      runtime.call({ pluginId: "fixture-memory", kind: "mcp", serverId: "memory", instanceToken: instanceB.instanceToken, toolName: "remember", arguments: { text: "B" } }),
    ]);
    assert.equal(instanceCallA.result.structuredContent.instanceMarker, "A");
    assert.equal(instanceCallB.result.structuredContent.instanceMarker, "B");
    assert.equal(instanceCallA.instanceId, "project-a");
    assert.equal(instanceCallB.instanceId, "project-b");
    const instanceList = await runtime.listInstances({ pluginId: "fixture-memory", serverId: "memory" });
    assert.deepEqual(instanceList.map((item) => item.instanceId), ["project-a", "project-b"]);
    assert.deepEqual(instanceList[0].envNames, ["CAP_INSTANCE_MARKER"]);
    assert.equal(JSON.stringify(instanceList).includes('"A"'), false);
    await runtime.releaseInstance(instanceA.instanceToken);
    await runtime.releaseInstance(instanceB.instanceToken);
    assert.equal((await runtime.listInstances()).length, 0);

    const probe = await runtime.probePluginMcp("fixture-memory");
    assert.equal(probe.memory.status, "online");
    assert.deepEqual(probe.memory.tools.map((tool) => tool.name), ["remember"]);
    assert.deepEqual(probe.memory.prompts.map((prompt) => prompt.name), ["memory-review"]);
    assert.deepEqual(probe.memory.resources.map((resource) => resource.uri), ["memory://fixture/status"]);
    assert.equal(probe["claude-memory"].status, "online");
    assert.equal(probe["profile:config/mcp-mode::profile-memory"].status, "online");
    assert.equal(probe["io.github.fixture/memory:package-1"].status, "unsupported");
    assert.equal(probe["io.github.fixture/memory:remote-1"].status, "error");
    assert.match(probe["io.github.fixture/memory:remote-1"].error, /Missing required remote MCP variable/);
    assert.equal(probe["io.github.fixture/memory:remote-2"].status, "error");
    assert.match(probe["io.github.fixture/memory:remote-2"].error, /must use http or https/);

    const mcp = await runtime.call({
      pluginId: "fixture-memory",
      kind: "mcp",
      serverId: "memory",
      toolName: "remember",
      arguments: { text: "hello" },
    });
    assert.equal(mcp.ok, true);
    assert.equal(mcp.result.structuredContent.stored, "hello");
    assert.equal(mcp.result.structuredContent.secretPresent, true);
    const mcpResource = await runtime.call({
      pluginId: "fixture-memory",
      kind: "mcp-resource",
      serverId: "memory",
      resourceUri: "memory://fixture/status",
      arguments: {},
    });
    assert.equal(mcpResource.result.contents[0].text, "fixture-resource-ok");
    const mcpPrompt = await runtime.call({
      pluginId: "fixture-memory",
      kind: "mcp-prompt",
      serverId: "memory",
      promptName: "memory-review",
      arguments: { topic: "retention" },
    });
    assert.equal(mcpPrompt.result.messages[0].content.text, "review-memory:retention");
    const claudeMcp = await runtime.call({
      pluginId: "fixture-memory",
      kind: "mcp",
      serverId: "claude-memory",
      toolName: "remember",
      arguments: { text: "nested-plugin-env" },
    });
    assert.equal(claudeMcp.result.structuredContent.secretPresent, true);

    const command = await runtime.call({
      pluginId: "fixture-memory",
      kind: "tool",
      toolName: "echo-json",
      arguments: { value: 42 },
    });
    assert.deepEqual(command.result, { echo: { value: 42 }, source: "command-tool" });

    const registryText = await readFile(registryPath, "utf8");
    assert.equal(registryText.includes("fixture-secret-not-for-registry"), false);
    assert.equal(registryText.includes("CAP_FIXTURE_SECRET"), false);

    const mainTools = [];
    const workerTools = [];
    registerCapabilityTools(fakeServer(mainTools), runtime);
    registerCapabilityTools(fakeServer(workerTools), runtime);
    const expectedNames = [
      "capability_list",
      "capability_search",
      "capability_import_codex",
      "capability_inspect",
      "capability_install",
      "capability_enable",
      "capability_disable",
      "capability_update",
      "capability_uninstall",
      "capability_refresh",
      "capability_read",
      "capability_instance",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "capability_call",
    ];
    assert.deepEqual(mainTools.map((item) => item.name), expectedNames);
    assert.deepEqual(workerTools.map((item) => item.name), expectedNames);

    const protocolMain = await connectCapabilityMcpSession(runtime, "main");
    const protocolWorker = await connectCapabilityMcpSession(runtime, "worker");
    try {
      const protocolMainTools = await protocolMain.client.listTools();
      const protocolWorkerTools = await protocolWorker.client.listTools();
      assert.deepEqual(protocolMainTools.tools.map((tool) => tool.name), expectedNames);
      assert.deepEqual(protocolWorkerTools.tools.map((tool) => tool.name), expectedNames);
      const protocolSearch = await protocolWorker.client.callTool({
        name: "capability_search",
        arguments: { query: "powermem-like memory", includeDisabled: false, limit: 10 },
      });
      assert.equal(protocolSearch.structuredContent.plugins[0].id, "fixture-memory");
      const protocolClaim = await protocolMain.client.callTool({
        name: "capability_instance",
        arguments: {
          action: "claim",
          pluginId: "fixture-memory",
          serverId: "memory",
          instanceId: "protocol-project",
          env: { CAP_INSTANCE_MARKER: "PROTOCOL" },
          leaseSeconds: 300,
        },
      });
      const protocolInstanceToken = protocolClaim.structuredContent.instanceToken;
      assert.ok(protocolInstanceToken);
      const competingProtocolClaim = await protocolWorker.client.callTool({
        name: "capability_instance",
        arguments: {
          action: "claim",
          pluginId: "fixture-memory",
          serverId: "memory",
          instanceId: "protocol-project",
          env: { CAP_INSTANCE_MARKER: "WORKER" },
          leaseSeconds: 300,
        },
      });
      assert.equal(competingProtocolClaim.isError, true);
      const protocolInstanceCall = await protocolMain.client.callTool({
        name: "capability_call",
        arguments: {
          pluginId: "fixture-memory",
          kind: "mcp",
          serverId: "memory",
          instanceToken: protocolInstanceToken,
          toolName: "remember",
          arguments: { text: "protocol-instance" },
        },
      });
      assert.equal(protocolInstanceCall.structuredContent.result.structuredContent.instanceMarker, "PROTOCOL");
      const protocolRelease = await protocolMain.client.callTool({
        name: "capability_instance",
        arguments: { action: "release", instanceToken: protocolInstanceToken },
      });
      assert.equal(protocolRelease.structuredContent.released, true);
    }
    finally {
      await protocolMain.client.close().catch(() => {});
      await protocolWorker.client.close().catch(() => {});
      await protocolMain.server.close().catch(() => {});
      await protocolWorker.server.close().catch(() => {});
    }

    const mainList = await mainTools.find((item) => item.name === "capability_list").handler({ includeDisabled: false, probeMcp: true });
    const workerList = await workerTools.find((item) => item.name === "capability_list").handler({ includeDisabled: false, probeMcp: false });
    assert.equal(mainList.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(workerList.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(Array.isArray(mainList.structuredContent.plugins[0].skills), false);
    assert.equal(mainList.structuredContent.plugins[0].counts.skills, 1);
    assert.equal(mainList.structuredContent.plugins[0].probedMcpPromptNames.includes("memory-review"), true);
    assert.equal(mainList.structuredContent.plugins[0].probedMcpResourceUris.includes("memory://fixture/status"), true);
    const searched = await workerTools.find((item) => item.name === "capability_search").handler({ query: "powermem-like memory", includeDisabled: false, limit: 10 });
    assert.equal(searched.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(searched.structuredContent.plugins[0].score > 0, true);

    await runtime.setEnabled("fixture-memory", false);
    await assert.rejects(() => runtime.call({
      pluginId: "fixture-memory",
      kind: "tool",
      toolName: "echo-json",
      arguments: {},
    }), /disabled/);

    const reenabled = await runtime.setEnabled("fixture-memory", true);
    assert.equal(reenabled.plugin.enabled, true);
    assert.equal(reenabled.plugin.trusted, true);
    const removed = await runtime.uninstall("fixture-memory");
    assert.equal(removed.removed, true);
    assert.equal((await runtime.list({ includeDisabled: true })).length, 0);

    console.log(JSON.stringify({
      ok: true,
      pluginInstall: true,
      credentialBearingGitSourceBlocked: true,
      trustGate: true,
      officialRegistryRemoteDescriptors: true,
      sharedBackendToolRegistration: mainTools.length,
      realMcpProtocolMainAndWorkerCatalog: true,
      mainAndWorkerCatalog: true,
      progressiveCapabilitySearch: true,
      dedupedSharedMcpConnection: true,
      isolatedStatefulMcpInstances: true,
      exclusiveInstanceClaim: true,
      refreshInvalidatesMcpClient: true,
      skillDiscovery: true,
      instructionRead: true,
      symlinkEscapeBlocked: true,
      remoteSchemeGuard: true,
      mcpProbeAndCall: true,
      mcpResourcesAndPrompts: true,
      commandToolCall: true,
      secretNotPersisted: true,
      disableAndUninstall: true,
    }));
  }
  finally {
    await runtime.close();
    delete process.env.CAP_FIXTURE_SECRET;
    await rm(root, { recursive: true, force: true });
  }
}

await run();
