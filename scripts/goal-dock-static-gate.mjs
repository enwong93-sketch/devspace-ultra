import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/ui/goal-dock.html", import.meta.url), "utf8");

assert.match(html, /devspace_goal_status/);
assert.match(html, /devspace_goal_continuation/);
assert.match(html, /devspace_goal_control/);
assert.match(html, /sendFollowUpMessage/);
assert.match(html, /action:\s*["']claim["']/);
assert.match(html, /action:\s*["']ack["']/);
assert.match(html, /action:\s*["']release["']/);
assert.match(html, /makeButton\(["']Pause["'],\s*["']pause["']\)/);
assert.match(html, /makeButton\(["']Resume["'],\s*["']resume["']\)/);
assert.match(html, /makeButton\(["']Stop["'],\s*["']stop["']/);
assert.match(html, /dispatchInFlight/);
assert.match(html, /document\.visibilityState/);
assert.match(html, /visibilitychange/);
assert.match(html, /ACTIVE_POLL_MS/);
assert.match(html, /HIDDEN_POLL_MS/);
assert.match(html, /status === ["']completed["']/);
assert.match(html, /status === ["']stopped["']/);
assert.match(html, /clearTimeout/);
assert.match(html, /--color-text-primary/);
assert.match(html, /--color-background-primary/);
assert.match(html, /--color-border-secondary/);
assert.match(html, /openai:set_globals/);
assert.match(html, /textContent/);
assert.match(html, /aria-live=/);
assert.match(html, /aria-label=/);
assert.match(html, /:focus-visible/);
assert.doesNotMatch(html, /<script[^>]+src=/i);
assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
assert.doesNotMatch(html, /https?:\/\//i);

console.log(JSON.stringify({ ok: true, gate: "goal-dock-static" }));
