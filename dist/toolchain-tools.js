import * as z from "zod/v4";
import { installToolchain, toolchainStatus } from "./toolchain.js";

const TIERS = ["core", "recommended", "media", "build"];
const READ_ONLY = { readOnlyHint: true };
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function result(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
function failure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

export function registerToolchainTools(server, dependencies = {}) {
  const status = dependencies.toolchainStatus || toolchainStatus;
  const install = dependencies.installToolchain || installToolchain;

  server.registerTool("toolchain_status", {
    title: "Local developer toolchain status",
    description: "Probe the allowlisted local development toolchain used by DevSpace agents. Reports core, recommended, media, and build tools without modifying the machine. Use ids for exact tools or tiers for groups; an empty selection checks the complete catalogue.",
    inputSchema: {
      ids: z.array(z.string().min(1).max(80)).max(40).default([]),
      tiers: z.array(z.enum(TIERS)).max(TIERS.length).default([]),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try { return result(await status(input)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("toolchain_install", {
    title: "Install allowlisted developer tools",
    description: "Plan or install missing allowlisted developer tools on Windows through winget. Dry-run is the default. apply=true performs silent exact-package installs with package/source agreements accepted. Arbitrary package IDs and shell commands are not accepted.",
    inputSchema: {
      ids: z.array(z.string().min(1).max(80)).max(20).default([]),
      tiers: z.array(z.enum(TIERS)).max(TIERS.length).default([]),
      apply: z.boolean().default(false),
    },
    annotations: MUTATING,
  }, async (input) => {
    try { return result(await install(input)); }
    catch (error) { return failure(error); }
  });
}
