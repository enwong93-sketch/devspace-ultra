import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableGatewayHumanProgress, handleStableGatewayHumanProgressRequest } from "./stable-gateway-human-progress.js";

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
  const post = await request(base, "POST", { message: "啱啱我已經完成本機浮窗資料層。依家會直接驗證你真正見到嘅自然語言更新。" });
  assert.equal(post.status, 200);
  const posted = JSON.parse(post.body);
  assert.equal(posted.messages.length, 1);
  assert.match(posted.messages[0].text, /自然語言更新/);

  const get = await request(base, "GET");
  assert.equal(get.status, 200);
  const snapshot = JSON.parse(get.body);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.messages.length, 1);

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
