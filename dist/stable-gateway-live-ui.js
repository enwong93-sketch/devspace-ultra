import { readFile } from "node:fs/promises";
import { join } from "node:path";

const LIVE_ROOT = "/__devspace/live";

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function newest(values, predicate) {
  return Object.values(values || {})
    .filter((item) => item && (!predicate || predicate(item)))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
}

function projectGoal(goal) {
  if (!goal) return null;
  return {
    id: String(goal.id || ""),
    objective: String(goal.objective || ""),
    status: String(goal.status || ""),
    round: Number(goal.round || 0),
    roundState: String(goal.roundState || ""),
    revision: Number(goal.revision || 0),
    updatedAt: goal.updatedAt || null,
  };
}

function projectPlan(plan) {
  if (!plan) return null;
  const steps = Array.isArray(plan.steps) ? plan.steps.map((step) => ({
    id: String(step?.id || ""),
    text: String(step?.text || ""),
    status: String(step?.status || ""),
  })) : [];
  return {
    id: String(plan.id || ""),
    title: String(plan.title || ""),
    status: String(plan.status || ""),
    revision: Number(plan.revision || 0),
    updatedAt: plan.updatedAt || null,
    steps,
  };
}

export async function readStableGatewayBackendSnapshot(stateDir) {
  const [goalState, planState] = await Promise.all([
    readJson(join(stateDir, "goal-state.json")),
    readJson(join(stateDir, "plan-state.json")),
  ]);
  const goal = newest(goalState?.goals, (item) => ["active", "paused", "blocked"].includes(item?.status));
  const plan = newest(planState?.plans, (item) => item?.status === "active");
  return { goal: projectGoal(goal), plan: projectPlan(plan) };
}

function send(res, statusCode, contentType, body) {
  const payload = Buffer.from(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(payload.length));
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(payload);
}

function isLoopback(value) {
  const address = String(value || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function renderStableGatewayLiveHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'">
<title>DevSpace Ultra Live</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f7;--surface:rgba(255,255,255,.96);--text:#111;--muted:#6b6b6b;--faint:#9a9a9a;--border:#e4e4e4;--ok:#138a63;--warn:#a15c00;--bad:#c43b3b;--shadow:0 8px 24px rgba(0,0,0,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#171717;--surface:rgba(34,34,34,.97);--text:#f1f1f1;--muted:#b5b5b5;--faint:#848484;--border:#383838;--shadow:0 10px 28px rgba(0,0,0,.26)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.45}.shell{max-width:1180px;margin:0 auto;padding:22px}.top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;margin-bottom:16px}.brand h1{font-size:20px;line-height:1.2;margin:0 0 5px;font-weight:650}.brand p{margin:0;color:var(--muted);max-width:760px}.pill{border:1px solid var(--border);border-radius:999px;background:var(--surface);padding:6px 10px;color:var(--muted);white-space:nowrap}.grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.75fr);gap:14px}.stack{display:grid;gap:14px}.card{border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow);padding:14px}.eyebrow{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}.big{font-size:16px;font-weight:620;overflow-wrap:anywhere}.sub{font-size:12px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 10px;font-size:12px}.kv b{color:var(--muted);font-weight:550}.feed{display:grid;gap:8px;margin-top:8px;max-height:65vh;overflow:auto;padding-right:3px}.event{display:grid;grid-template-columns:74px 10px minmax(0,1fr);gap:8px;align-items:start;border-top:1px solid var(--border);padding-top:8px}.event:first-child{border-top:0;padding-top:0}.time{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}.dot{width:8px;height:8px;border-radius:999px;background:var(--faint);margin-top:4px}.dot.running{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 14%,transparent)}.dot.completed{background:var(--ok)}.dot.failed{background:var(--bad)}.event-title{font-size:12px;font-weight:560;overflow-wrap:anywhere}.event-detail{font-size:11px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.steps{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:5px}.step{display:grid;grid-template-columns:48px minmax(0,1fr);gap:7px;font-size:12px;color:var(--muted)}.step[data-status="in_progress"]{color:var(--text);font-weight:560}.step-state{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint)}.notice{margin-top:14px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:12px;background:color-mix(in srgb,var(--surface) 82%,var(--bg))}.empty{font-size:12px;color:var(--faint)}
@media(max-width:780px){.shell{padding:12px}.grid{grid-template-columns:1fr}.top{flex-direction:column}.feed{max-height:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style>
</head>
<body>
<main class="shell">
  <header class="top"><div class="brand"><h1>DevSpace Ultra Live</h1><p>Local backend activity mirror. This surface stays independent from the ChatGPT renderer and never refreshes or controls the ChatGPT page.</p></div><div class="pill" id="clock">Connecting…</div></header>
  <section class="grid">
    <div class="stack">
      <article class="card"><div class="eyebrow">Current operation</div><div class="big" id="current-title">Waiting for backend activity…</div><div class="sub" id="current-detail"></div></article>
      <article class="card"><div class="eyebrow">Recent tool activity</div><div class="feed" id="feed"><div class="empty">No activity captured yet.</div></div></article>
    </div>
    <aside class="stack">
      <article class="card"><div class="eyebrow">Stable Gateway</div><div class="kv" id="gateway"></div></article>
      <article class="card"><div class="eyebrow">Goal</div><div id="goal" class="empty">No projectable Goal.</div></article>
      <article class="card"><div class="eyebrow">Plan</div><div id="plan" class="empty">No active Plan.</div></article>
    </aside>
  </section>
  <div class="notice">Authority boundary: Goal/Plan data comes from DevSpace backend state files; tool activity comes from Stable Gateway MCP traffic. ChatGPT DOM is not used to decide backend state, context usage, recovery, or compaction.</div>
</main>
<script>
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=(v)=>{try{return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return ''}};
function render(s){
  document.getElementById('clock').textContent='Updated '+new Date().toLocaleTimeString();
  const g=s.gateway||{}; const a=g.admission||{};
  document.getElementById('gateway').innerHTML='<b>State</b><span>'+esc(g.ok?'Ready':'Degraded')+'</span><b>Core</b><span>'+esc((g.activeSlot||'?').toUpperCase())+' · PID '+esc(g.activePid??'—')+'</span><b>Recovery</b><span>'+esc(g.coreRecoveryInProgress?'Running':(g.fatal?'Failed':'Idle'))+'</span><b>Requests</b><span>'+esc(a.activeRequests??0)+' active · '+esc(a.queuedRequests??0)+' queued</span><b>Sessions</b><span>'+esc(s.gatewaySessions??0)+'</span>';
  const goal=s.backend?.goal;
  document.getElementById('goal').innerHTML=goal?'<div class="big">'+esc(goal.objective)+'</div><div class="sub">'+esc(goal.id)+' · Round '+esc(goal.round)+' · '+esc(goal.status)+' · rev '+esc(goal.revision)+'</div>':'<div class="empty">No projectable Goal.</div>';
  const plan=s.backend?.plan;
  document.getElementById('plan').innerHTML=plan?'<div class="big">'+esc(plan.title)+'</div><div class="sub">'+esc(plan.id)+' · '+esc(plan.status)+' · rev '+esc(plan.revision)+'</div><ul class="steps">'+(plan.steps||[]).map(x=>'<li class="step" data-status="'+esc(x.status)+'"><span class="step-state">'+esc(x.status==='completed'?'Done':x.status==='in_progress'?'Now':'Next')+'</span><span>'+esc(x.text)+'</span></li>').join('')+'</ul>':'<div class="empty">No active Plan.</div>';
  const items=s.activity?.activities||[]; const running=items.find(x=>x.state==='running'); const current=running||items[0];
  document.getElementById('current-title').textContent=current?.title||'Waiting for backend activity…';
  document.getElementById('current-detail').textContent=current?(current.state+(current.durationMs!=null?' · '+current.durationMs+' ms':'')+(current.error?' · '+current.error:'')):'';
  document.getElementById('feed').innerHTML=items.length?items.slice(0,80).map(x=>'<div class="event"><div class="time">'+esc(time(x.startedAt))+'</div><span class="dot '+esc(x.state)+'"></span><div><div class="event-title">'+esc(x.title)+'</div><div class="event-detail">'+esc(x.kind+(x.durationMs!=null?' · '+x.durationMs+' ms':'')+(x.statusCode!=null?' · HTTP '+x.statusCode:'')+(x.detail?' · '+x.detail:'')+(x.error?' · '+x.error:''))+'</div></div></div>').join(''):'<div class="empty">No activity captured yet.</div>';
}
async function tick(){try{const r=await fetch('${LIVE_ROOT}/snapshot',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);render(await r.json())}catch(e){document.getElementById('clock').textContent='Disconnected';document.getElementById('current-detail').textContent=String(e)}}
tick();setInterval(tick,900);
</script>
</body></html>`;
}

export async function handleStableGatewayLiveRequest(req, res, { stateDir, controller, journal } = {}) {
  let pathname;
  try { pathname = new URL(req.url || "/", "http://127.0.0.1").pathname; } catch { return false; }
  if (pathname !== LIVE_ROOT && pathname !== `${LIVE_ROOT}/snapshot`) return false;
  if (!isLoopback(req.socket?.remoteAddress)) {
    send(res, 403, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "loopback-only" }));
    return true;
  }
  if (req.method !== "GET") {
    send(res, 405, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "method-not-allowed" }));
    return true;
  }
  if (pathname === LIVE_ROOT) {
    send(res, 200, "text/html; charset=utf-8", renderStableGatewayLiveHtml());
    return true;
  }
  const gateway = controller?.status?.() || {};
  const backend = stateDir ? await readStableGatewayBackendSnapshot(stateDir) : { goal: null, plan: null };
  const activity = journal?.snapshot?.() || { activities: [], running: 0 };
  send(res, 200, "application/json; charset=utf-8", JSON.stringify({
    ok: true,
    at: new Date().toISOString(),
    gateway,
    gatewaySessions: gateway?.sessions?.sessions?.length || 0,
    backend,
    activity,
  }));
  return true;
}

export const stableGatewayLiveUi = Object.freeze({ root: LIVE_ROOT });
