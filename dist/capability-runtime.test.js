import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CapabilityRuntime,
  installedCapabilitySkillPaths,
  registerCapabilityTools,
} from "./capability-runtime.js";

async function makeFixtureSource(root) {
  const source = join(root, "fixture-source");
  await mkdir(join(source, "skills", "powermem-like", "agents"), { recursive: true });
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
    routing: {
      aliases: ["durable memory", "remember prior decisions"],
      exclude: ["temporary scratchpad only"],
      priority: 4
    },
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
    requires_local_executor: false,
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
  await writeFile(join(source, "skills", "powermem-like", "SKILL.md"), `---\nname: powermem-like\ndescription: Reusable test memory workflow for prior decisions and durable preferences.\nrouting:\n  aliases:\n    - recall user history\n  exclude:\n    - disposable note\n---\n# Memory skill\nUse the MCP memory tool.\n`);
  await writeFile(join(source, "skills", "powermem-like", "agents", "openai.yaml"), `interface:\n  display_name: "PowerMem Like"\n  short_description: "Recall and store durable user decisions"\n  default_prompt: "Use $powermem-like to recall relevant prior decisions before work."\ndependencies:\n  tools:\n    - type: "mcp"\n      value: "memory"\n      description: "Memory MCP server"\npolicy:\n  allow_implicit_invocation: true\n`);
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
      const record = { name, definition, handler };
      registrations.push(record);
      return {
        update(updates = {}) { Object.assign(record.definition, updates); },
      };
    },
  };
}

async function connectCapabilityMcpSession(runtime, label) {
  const server = new McpServer({ name: `capability-test-server-${label}`, version: "0.3.0-dev" });
  registerCapabilityTools(server, runtime, {
    resolveConversation: async () => ({ conversationId: `conversation-${label}` }),
  });
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
    assert.deepEqual(installed.plugin.detectedFormats.sort(), ["agent-instructions", "agent-skills", "claude-agents", "claude-commands", "claude-hooks-metadata", "claude-plugin", "codex-app-dependencies", "codex-bundled-content-metadata", "codex-execution-requirements-metadata", "codex-hooks-metadata", "codex-interface-metadata", "codex-plugin", "command-tools", "devspace-plugin", "mcp", "mcp-registry-server-json", "nested-mcp-profiles"].sort());
    assert.equal(installed.plugin.skills[0].name, "powermem-like");
    assert.equal(installed.plugin.skills[0].displayName, "PowerMem Like");
    assert.equal(installed.plugin.skills[0].shortDescription, "Recall and store durable user decisions");
    assert.deepEqual(installed.plugin.skills[0].defaultPrompts, ["Use $powermem-like to recall relevant prior decisions before work."]);
    assert.equal(installed.plugin.skills[0].dependencies.some((value) => /memory mcp server/i.test(value)), true);
    assert.equal(installed.plugin.skills[0].routing.aliases.includes("recall user history"), true);
    assert.equal(installed.plugin.skills[0].routing.negativeTriggers.includes("disposable note"), true);
    assert.equal(installed.plugin.routingAliases.includes("durable memory"), true);
    assert.equal(installed.plugin.routing.negativeTriggers.includes("temporary scratchpad only"), true);
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
    assert.deepEqual(installed.plugin.codexExecutionRequirements, [{
      pluginRoot: "",
      requiresLocalExecutor: false,
      declaredValueValid: true,
    }]);
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

    const [internalMcpA, internalMcpB, internalMcpC] = await Promise.all([
      runtime.getMcpClient("fixture-memory", "memory"),
      runtime.getMcpClient("fixture-memory", "memory"),
      runtime.getMcpClient("fixture-memory", "memory"),
    ]);
    assert.equal(internalMcpA, internalMcpB, "internal discovery calls may reuse only the isolated internal-service connection");
    assert.equal(internalMcpB, internalMcpC);
    const conversationMcpA = await runtime.getMcpClient("fixture-memory", "memory", undefined, "conversation-a");
    const conversationMcpAAgain = await runtime.getMcpClient("fixture-memory", "memory", undefined, "conversation-a");
    const conversationMcpB = await runtime.getMcpClient("fixture-memory", "memory", undefined, "conversation-b");
    assert.equal(conversationMcpA, conversationMcpAAgain);
    assert.notEqual(conversationMcpA, conversationMcpB, "different conversations must receive different MCP clients by default");
    assert.notEqual(conversationMcpA, internalMcpA, "agent calls must not reuse the internal discovery connection");
    await runtime.refresh({ pluginId: "fixture-memory", probeMcp: false });
    const refreshedMcp = await runtime.getMcpClient("fixture-memory", "memory");
    assert.notEqual(refreshedMcp, internalMcpA);

    const memoryDefinition = runtime.discovered.get("fixture-memory").mcpServers.find((server) => server.id === "memory");
    const internalPolicy = runtime.mcpConnectionPolicy(memoryDefinition, null, null);
    const internalKey = runtime.clientKey("fixture-memory", "memory", null, internalPolicy);
    await runtime.closeClientKey(internalKey);
    let requestOptions = "not-called";
    let pooledClientClosed = 0;
    let pooledTransportClosed = 0;
    const noDeadlineHolder = {
      client: { async close() { pooledClientClosed += 1; } },
      transport: { async close() { pooledTransportClosed += 1; } },
      definition: {},
    };
    runtime.mcpClients.set(internalKey, noDeadlineHolder);
    runtime.connectionManager.connectionStates.set(internalKey, {
      key: internalKey,
      pluginId: "fixture-memory",
      serverId: "memory",
      scope: "conversation-isolated",
      isolationKind: "conversation",
      ownerConversationId: internalPolicy.ownerConversationId,
      state: "ready",
      connecting: false,
    });
    const noDeadlineResult = await runtime.executeMcpRequest("fixture-memory", "memory", undefined, async (_client, options) => {
      requestOptions = options;
      return { ok: true };
    });
    assert.deepEqual(noDeadlineResult.result, { ok: true });
    assert.equal(requestOptions, undefined, "Capability MCP calls must not receive SDK wall-clock timeout options");
    assert.equal(pooledClientClosed, 0);
    assert.equal(pooledTransportClosed, 0);
    assert.equal(runtime.mcpClients.get(internalKey), noDeadlineHolder, "a healthy client must remain in its isolated scope without a timeout-driven recycle");
    await runtime.closeClientKey(internalKey);
    const recoveredMcp = await runtime.getMcpClient("fixture-memory", "memory");
    assert.notEqual(recoveredMcp, refreshedMcp);

    const instanceA = await runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-a",
      ownerLabel: "agent-A",
      ownerConversationId: "conversation-a",
      env: { CAP_INSTANCE_MARKER: "A" },
    });
    const instanceB = await runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-b",
      ownerLabel: "agent-B",
      ownerConversationId: "conversation-b",
      env: { CAP_INSTANCE_MARKER: "B" },
    });
    await assert.rejects(() => runtime.claimInstance({
      pluginId: "fixture-memory",
      serverId: "memory",
      instanceId: "project-a",
      ownerLabel: "competing-agent",
      ownerConversationId: "conversation-c",
      env: {},
    }), /belongs to another conversation|already claimed/);
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
    assert.equal(instanceList[0].expiresAt, null, "stateful capability instances must remain active until explicit release, not a lease deadline");
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
      "capability_route",
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
      "capability_connection",
      "capability_instance",
      "devspace_connection_isolation_status",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "blender_runtime",
      "blender_mcp",
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
      const protocolRouteTool = protocolWorkerTools.tools.find((tool) => tool.name === "capability_route");
      assert.equal(protocolRouteTool._meta.devspace.routingContractVersion, "1");
      const blenderExecutionTool = protocolWorkerTools.tools.find((tool) => tool.name === "blender_mcp");
      assert.match(blenderExecutionTool.description, /actual execution entry point/i);
      assert.match(protocolRouteTool._meta.devspace.routingFingerprint, /^[a-f0-9]{64}$/);
      const protocolSearch = await protocolWorker.client.callTool({
        name: "capability_search",
        arguments: { query: "powermem-like memory", includeDisabled: false, limit: 10 },
      });
      assert.equal(protocolSearch.structuredContent.plugins[0].id, "fixture-memory");
      const protocolRoute = await protocolWorker.client.callTool({
        name: "capability_route",
        arguments: { query: "recall durable user decisions", includeDisabled: false, probeMcp: false, limit: 8 },
      });
      assert.equal(protocolRoute.structuredContent.primary.kind, "skill");
      assert.equal(protocolRoute.structuredContent.primary.name, "powermem-like");
      assert.deepEqual(protocolRoute.structuredContent.primary.nextAction, {
        arguments: { path: "skills/powermem-like/SKILL.md", pluginId: "fixture-memory" },
        then: "Follow the selected SKILL.md and resolve only its declared tool dependencies.",
        tool: "capability_read",
      });
      assert.match(protocolRoute.structuredContent.routingFingerprint, /^[a-f0-9]{64}$/);
      const protocolClaim = await protocolMain.client.callTool({
        name: "capability_instance",
        arguments: {
          action: "claim",
          pluginId: "fixture-memory",
          serverId: "memory",
          instanceId: "protocol-project",
          env: { CAP_INSTANCE_MARKER: "PROTOCOL" },
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

    const routingFingerprintBeforeProbe = runtime.routingFingerprint({ includeDisabled: true });
    const mainList = await mainTools.find((item) => item.name === "capability_list").handler({ includeDisabled: false, probeMcp: true });
    const workerList = await workerTools.find((item) => item.name === "capability_list").handler({ includeDisabled: false, probeMcp: false });
    assert.equal(mainList.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(workerList.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(Array.isArray(mainList.structuredContent.plugins[0].skills), false);
    assert.equal(mainList.structuredContent.plugins[0].counts.skills, 1);
    assert.equal(mainList.structuredContent.plugins[0].probedMcpPromptNames.includes("memory-review"), true);
    assert.equal(mainList.structuredContent.plugins[0].probedMcpResourceUris.includes("memory://fixture/status"), true);
    assert.equal(runtime.routingFingerprint({ includeDisabled: true }), routingFingerprintBeforeProbe, "session routing fingerprint must not depend on whether deferred MCP schemas happened to be probed");
    const searched = await workerTools.find((item) => item.name === "capability_search").handler({ query: "powermem-like memory", includeDisabled: false, limit: 10 });
    assert.equal(searched.structuredContent.plugins[0].id, "fixture-memory");
    assert.equal(searched.structuredContent.plugins[0].score > 0, true);
    const routed = await workerTools.find((item) => item.name === "capability_route").handler({ query: "remember prior decisions", includeDisabled: false, probeMcp: false, limit: 8 });
    assert.equal(routed.structuredContent.primary.kind, "skill");
    assert.equal(routed.structuredContent.primary.pluginId, "fixture-memory");
    assert.equal(routed.structuredContent.primary.nextAction.tool, "capability_read");
    const runtimeRoute = await workerTools.find((item) => item.name === "capability_route").handler({
      query: "兩個 agent 同時操作兩個 Blender，用不同 port 同獨立 runtime",
      includeDisabled: false,
      probeMcp: false,
      limit: 8,
    });
    assert.equal(runtimeRoute.structuredContent.primary.kind, "runtime");
    assert.equal(runtimeRoute.structuredContent.primary.routeId, "runtime:blender-isolated");
    assert.equal(runtimeRoute.structuredContent.primary.nextAction.tool, "blender_runtime");
    const connectionRoute = await workerTools.find((item) => item.name === "capability_route").handler({
      query: "set up isolated MCP connection manager for multiple application ports",
      includeDisabled: false,
      probeMcp: false,
      limit: 8,
    });
    assert.equal(connectionRoute.structuredContent.primary.kind, "workflow");
    assert.equal(connectionRoute.structuredContent.primary.nextAction.tool, "capability_connection");
    const progressRoute = await workerTools.find((item) => item.name === "capability_route").handler({
      query: "完成中型步驟後親自寫進度旁白卡俾用戶",
      includeDisabled: false,
      probeMcp: false,
      limit: 8,
    });
    assert.equal(progressRoute.structuredContent.primary.kind, "workflow");
    assert.equal(progressRoute.structuredContent.primary.nextAction.tool, "devspace_progress_report");
    assert.equal(workerTools.find((item) => item.name === "capability_route").definition._meta.devspace.routingContractVersion, "1");
    assert.match(workerTools.find((item) => item.name === "capability_route").definition._meta.devspace.routingFingerprint, /^[a-f0-9]{64}$/);

    const liveRouteDefinition = mainTools.find((item) => item.name === "capability_route").definition;
    const fixtureOnlyRoutingFingerprint = liveRouteDefinition._meta.devspace.routingFingerprint;
    const liveRoutingProtocol = await connectCapabilityMcpSession(runtime, "live-routing-refresh");
    let toolListChangedNotifications = 0;
    liveRoutingProtocol.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      toolListChangedNotifications += 1;
    });
    const protocolFingerprintBeforeMutation = (await liveRoutingProtocol.client.listTools()).tools
      .find((tool) => tool.name === "capability_route")._meta.devspace.routingFingerprint;
    const computerUseSource = join(root, "computer-use-source");
    await mkdir(join(computerUseSource, "skills", "computer-use"), { recursive: true });
    await mkdir(join(computerUseSource, ".codex-plugin"), { recursive: true });
    await writeFile(join(computerUseSource, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "computer-use",
      version: "1.0.0",
      description: "Control desktop apps on Windows from ChatGPT through Computer Use.",
      keywords: ["computer-use", "desktop-control", "windows", "automation"],
      skills: "./skills/",
      interface: {
        displayName: "Computer Use",
        shortDescription: "Control Windows apps",
        defaultPrompt: ["Open Notepad", "Build the open project in Visual Studio"],
      },
    }, null, 2));
    await writeFile(join(computerUseSource, "skills", "computer-use", "SKILL.md"), "---\nname: computer-use\ndescription: Control Windows apps\n---\n# Computer Use\n");
    const installedComputerUse = await runtime.install({ source: computerUseSource, enable: true, trust: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(installedComputerUse.plugin.id, "computer-use");
    const withComputerUseRoutingFingerprint = liveRouteDefinition._meta.devspace.routingFingerprint;
    assert.notEqual(withComputerUseRoutingFingerprint, fixtureOnlyRoutingFingerprint, "an installed route must update the live model-facing capability_route metadata");
    assert.equal(toolListChangedNotifications >= 1, true, "active MCP clients must be told that the model-facing routing surface changed");
    const protocolFingerprintAfterInstall = (await liveRoutingProtocol.client.listTools()).tools
      .find((tool) => tool.name === "capability_route")._meta.devspace.routingFingerprint;
    assert.notEqual(protocolFingerprintAfterInstall, protocolFingerprintBeforeMutation);
    assert.equal(protocolFingerprintAfterInstall, withComputerUseRoutingFingerprint);
    const desktopRoute = await runtime.search("open excel windows desktop app", { limit: 10 });
    assert.equal(desktopRoute[0].id, "computer-use");
    assert.equal(desktopRoute[0].routingAliases.some((value) => value.includes("excel")), true);
    const notepadRoute = await runtime.search("open notepad", { limit: 10 });
    assert.equal(notepadRoute[0].id, "computer-use");
    const removedComputerUse = await runtime.uninstall("computer-use");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(removedComputerUse.removed, true);
    assert.equal(liveRouteDefinition._meta.devspace.routingFingerprint, fixtureOnlyRoutingFingerprint, "removing the route must restore the prior live routing fingerprint");
    const protocolFingerprintAfterRemoval = (await liveRoutingProtocol.client.listTools()).tools
      .find((tool) => tool.name === "capability_route")._meta.devspace.routingFingerprint;
    assert.equal(protocolFingerprintAfterRemoval, protocolFingerprintBeforeMutation);
    await liveRoutingProtocol.client.close().catch(() => {});
    await liveRoutingProtocol.server.close().catch(() => {});

    await runtime.setEnabled("fixture-memory", false);
    await Promise.resolve();
    const disabledRoutingFingerprint = liveRouteDefinition._meta.devspace.routingFingerprint;
    assert.notEqual(disabledRoutingFingerprint, fixtureOnlyRoutingFingerprint, "enable/disable policy is part of the live routing surface");
    await assert.rejects(() => runtime.call({
      pluginId: "fixture-memory",
      kind: "tool",
      toolName: "echo-json",
      arguments: {},
    }), /disabled/);

    const reenabled = await runtime.setEnabled("fixture-memory", true);
    await Promise.resolve();
    assert.equal(reenabled.plugin.enabled, true);
    assert.equal(liveRouteDefinition._meta.devspace.routingFingerprint, fixtureOnlyRoutingFingerprint);
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
      liveToolListChangedRouting: true,
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
