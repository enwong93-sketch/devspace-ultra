#!/usr/bin/env node
import { probeFixedEdge } from "../dist/edge-cloudflare.js";
import { loadDevspaceFiles } from "../dist/user-config.js";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

function normalizeBase(value) {
  const parsed = new URL(String(value || "").trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/, "");
}

async function probeHealth(baseUrl) {
  if (!baseUrl) return null;
  try {
    const response = await fetch(`${normalizeBase(baseUrl)}/healthz`, {
      redirect: "manual",
      cache: "no-store",
    });
    let body = null;
    try { body = await response.json(); } catch {}
    return {
      status: response.status,
      ok: response.ok && body?.ok === true,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const files = loadDevspaceFiles();
const edgeUrl = arg("edge") ?? files.config.edgePublicBaseUrl ?? files.config.publicBaseUrl;
const originUrl = arg("origin") ?? files.config.edgeOriginBaseUrl ?? null;

if (!edgeUrl) {
  console.log(JSON.stringify({ ok: false, reason: "edge-url-missing", secretValuesLogged: false }));
  process.exit(2);
}

const normalizedEdge = normalizeBase(edgeUrl);
const fixed = !/\.trycloudflare\.com$/i.test(new URL(normalizedEdge).hostname);
let edge;
try {
  edge = await probeFixedEdge(normalizedEdge);
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    reason: "edge-probe-failed",
    publicBaseUrl: normalizedEdge,
    fixed,
    error: error instanceof Error ? error.message : String(error),
    secretValuesLogged: false,
  }));
  process.exit(2);
}

const origin = await probeHealth(originUrl);
const ok = Boolean(fixed && edge.ok && (!origin || origin.ok));
console.log(JSON.stringify({
  ok,
  fixed,
  publicBaseUrl: normalizedEdge,
  originBaseUrl: originUrl ? normalizeBase(originUrl) : null,
  edge,
  origin,
  secretValuesLogged: false,
}, null, 2));
if (!ok) process.exitCode = 2;
