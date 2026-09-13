import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayHumanProgress, handleStableGatewayHumanProgressRequest } from "./stable-gateway-human-progress.js";
import { EXACT_CONVERSATION_REQUEST_PROOF } from "./progress-ownership-proof.js";

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
function request(base, method, body) {
  const target = new URL("/__devspace/progress", base);
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: payload.length ? { "content-type": "application/json", "content-length": String(payload.length) } : {} }, (res) => {
      const chunks = []; res.on("data", c => chunks.push(Buffer.from(c))); res.once("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject); req.end(payload);
  });
}

const root = await mkdtemp(join(tmpdir(), "devspace-human-progress-http-"));
const progress = await createStableGatewayHumanProgress({ statePath: join(root, "progress.json") });
const server = createServer((req, res) => { void handleStableGatewayHumanProgressRequest(req, res, { progress }); });
const base = await listen(server);
try {
  const post = await request(base, "POST", {
    message: "啱啱我已經完成本機浮窗資料層。依家會直接驗證你真正見到嘅自然語言更新。",
    conversationId: "conversation-a",
    goalId: "goal-a",
    round: 1,
    planId: "plan-a",
    planStepId: "step-a",
    source: "goal-run-events",
    kind: "milestone",
    dedupeKey: "goal-a:1:milestone:one",
    toolCategory: "verification",
    toolStepCount: 4,
  });
  assert.equal(post.status, 200);
  const posted = JSON.parse(post.body);
  assert.equal(posted.messages.length, 1);
  assert.match(posted.messages[0].text, /自然語言更新/);
  assert.equal(posted.messages[0].conversationId, "conversation-a");
  assert.equal(posted.messages[0].goalId, "goal-a");
  assert.equal(posted.messages[0].dedupeKey, "goal-a:1:milestone:one");
  assert.equal(posted.messages[0].toolCategory, "verification");
  assert.equal(posted.messages[0].toolStepCount, 4);

  const duplicate = await request(base, "POST", {
    message: "唔應該重複顯示",
    conversationId: "conversation-a",
    goalId: "goal-a",
    round: 1,
    source: "goal-run-events",
    kind: "milestone",
    dedupeKey: "goal-a:1:milestone:one",
  });
  assert.equal(duplicate.status, 200);
  assert.equal(JSON.parse(duplicate.body).messages.length, 1);

  const get = await request(base, "GET");
  assert.equal(get.status, 200);
  const snapshot = JSON.parse(get.body);
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.messages.length, 1);

  const unproved = await request(base, "POST", {
    message: "unproved direct progress",
    conversationId: "conversation-direct",
    source: "agent-progress-tool",
  });
  assert.equal(unproved.status, 400);

  const proved = await request(base, "POST", {
    message: "exact direct progress",
    conversationId: "conversation-direct",
    source: "agent-progress-tool",
    kind: "verification",
    ownershipProof: EXACT_CONVERSATION_REQUEST_PROOF,
    ownershipSource: "classic-websocket-tool-invocation-correlation-page-verified",
    ownershipObservedAt: "2026-09-13T04:30:00.000Z",
    ownershipRuntimeKey: "main-03",
    ownershipCallFingerprint: "b".repeat(64),
  });
  assert.equal(proved.status, 200);
  assert.equal(JSON.parse(proved.body).messages.at(-1).conversationId, "conversation-direct");

  const legacy = await request(base, "POST", { doing: "legacy doing", completed: "legacy completed" });
  assert.equal(legacy.status, 200, "legacy progress writers must remain accepted during migration");

  const bad = await request(base, "POST", { message: "Bearer secret-value" });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.body, /secret-value/);

  const method = await request(base, "DELETE");
  assert.equal(method.status, 405);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-human-progress-http", loopbackFeed: true, naturalLanguageStream: true }));
