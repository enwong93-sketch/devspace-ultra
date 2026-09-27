import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  readme, contract, oneCommand, setupSkill, networkSkill,
  setupAgent, networkAgent, plugin,
] = await Promise.all([
  'README.md',
  'docs/CHATGPT_CLASSIC_MCP_INSTALLATION.md',
  'docs/ONE_COMMAND_SETUP.md',
  'skills/devspace-ultra-setup/SKILL.md',
  'capabilities/devspace-network-setup/skills/devspace-network-setup/SKILL.md',
  'skills/devspace-ultra-setup/agents/openai.yaml',
  'capabilities/devspace-network-setup/skills/devspace-network-setup/agents/openai.yaml',
  'capabilities/devspace-network-setup/devspace-plugin.json',
].map(read));

for (const [name, source] of [
  ['README', readme], ['canonical contract', contract], ['setup Skill', setupSkill],
  ['network Skill', networkSkill], ['setup Agent interface', setupAgent],
  ['network Agent interface', networkAgent],
]) {
  assert.match(source, /ChatGPT Classic/i, `${name} must identify ChatGPT Classic`);
  assert.match(source, /not Codex|Codex is \*{0,2}not\*{0,2}|Codex.*not the (?:product|installation) target/i, `${name} must state that Codex is not the product target`);
}

assert.match(contract, /```mermaid[\s\S]*flowchart TD/);
assert.match(contract, /ChatGPT Classic: enable Developer mode/);
assert.match(contract, /Create one connection for exact https:\/\/host\/mcp/);
assert.match(contract, /Complete OAuth/);
assert.match(contract, /Scan or refresh tools/);
assert.match(contract, /Enable connection in a fresh Classic chat/);
assert.match(contract, /Real read test/);
assert.match(contract, /Authorized disposable write\/edit\/command and read-back/);
assert.match(contract, /Stateful tools survive host-session alias rotation/);
assert.match(contract, /Reconnect or second fresh chat test/);
assert.match(contract, /Report every step PASS/);
assert.match(contract, /developers\.openai\.com\/plugins\/deploy\/connect-chatgpt/);
assert.match(contract, /does not increase or bypass OpenAI context, token, account usage or rate limits/i);
assert.match(contract, /wait for the bounded request-scoped exact-page correlation/i);
assert.match(contract, /fixed timer must not make an active Agent periodically lose work tools/i);
assert.match(contract, /Duplicate pages, another conversation reusing the same host session, another computer\/resource or missing exact-page proof must still fail closed/i);

const requiredTools = ['read', 'write', 'edit', 'apply_patch', 'exec_command', 'write_stdin', 'devspace_progress_report'];
for (const tool of requiredTools) {
  for (const [name, source] of [['canonical contract', contract], ['setup Skill', setupSkill], ['network Skill', networkSkill]]) {
    assert.match(source, new RegExp(`\\b${tool}\\b`), `${name} must require ${tool}`);
  }
}

for (const [name, source] of [['setup Skill', setupSkill], ['network Skill', networkSkill]]) {
  assert.match(source, /Developer mode/i, `${name} must require Developer mode`);
  assert.match(source, /create (?:one|the|an|the exact) .*connection|Add one connection/i, `${name} must require connection creation`);
  assert.match(source, /complete OAuth/i, `${name} must require OAuth completion`);
  assert.match(source, /fresh (?:ChatGPT )?Classic conversation/i, `${name} must require fresh-chat enablement`);
  assert.match(source, /disposable write|disposable write\/edit\/command/i, `${name} must require a real disposable write test`);
  assert.match(source, /reconnect|second fresh/i, `${name} must require persistence verification`);
  assert.match(source, /alias rotation|rotat(?:es|ion)[^\r\n]{0,100}alias/i, `${name} must require stateful tool continuity across host alias rotation`);
  assert.match(source, /fixed timer/i, `${name} must reject timer-based capability expiry during active verified work`);
  assert.match(source, /fail(?:-| )closed/i, `${name} must preserve cross-conversation and cross-computer isolation`);
  assert.match(source, /pass\/fail/i, `${name} must require an explicit gate report`);
}

assert.match(readme, /ChatGPT Classic MCP installation contract/);
assert.match(oneCommand, /ChatGPT Classic MCP connection, OAuth and read\/write\/reconnect workflow/);

const parsedPlugin = JSON.parse(plugin);
assert.match(parsedPlugin.name, /ChatGPT Classic/);
assert.match(parsedPlugin.description, /Classic connection, OAuth, full tools and read\/write\/reconnect evidence/i);

console.log(JSON.stringify({
  ok: true,
  gate: 'chatgpt-classic-install-contract',
  productTarget: 'chatgpt-classic',
  codexIsProductTarget: false,
  orderedGraph: true,
  requiredTools,
  realReadWriteReconnect: true,
  statefulAliasRotationContinuity: true,
  activeLeaseKeepalive: true,
  crossConversationIsolation: true,
  literalUnlimitedTokenClaim: false,
}));
