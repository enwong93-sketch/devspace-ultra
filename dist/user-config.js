import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
export function devspaceConfigDir(env = process.env) {
    return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}
export function devspaceConfigPath(env = process.env) {
    return join(devspaceConfigDir(env), "config.json");
}
export function devspaceAuthPath(env = process.env) {
    return join(devspaceConfigDir(env), "auth.json");
}
export function devspaceSkillsDir(env = process.env) {
    return join(devspaceConfigDir(env), "skills");
}
export function devspaceAgentsDir(env = process.env) {
    return join(devspaceConfigDir(env), "agents");
}
export function devspacePluginsDir(env = process.env) {
    return join(devspaceConfigDir(env), "plugins");
}
export function devspaceCapabilityRegistryPath(env = process.env) {
    return join(devspacePluginsDir(env), "registry.json");
}
export function loadDevspaceFiles(env = process.env) {
    const dir = devspaceConfigDir(env);
    const configPath = join(dir, "config.json");
    const authPath = join(dir, "auth.json");
    const configExists = existsSync(configPath);
    const authExists = existsSync(authPath);
    return {
        dir,
        configPath,
        authPath,
        configExists,
        authExists,
        config: configExists ? readJsonFile(configPath) : {},
        auth: authExists ? readJsonFile(authPath) : {},
    };
}
export function writeDevspaceConfig(config, env = process.env) {
    const filePath = devspaceConfigPath(env);
    mkdirSync(devspaceConfigDir(env), { recursive: true });
    writeJsonFile(filePath, config, 0o600);
    return filePath;
}
export function writeDevspaceAuth(auth, env = process.env) {
    const filePath = devspaceAuthPath(env);
    mkdirSync(devspaceConfigDir(env), { recursive: true });
    writeJsonFile(filePath, auth, 0o600);
    return filePath;
}
export function generateOwnerToken() {
    return randomBytes(32).toString("base64url");
}
export function ensureDevspaceDefaultSkills(env = process.env) {
    const targetPath = join(devspaceSkillsDir(env), "subagent-delegation", "SKILL.md");
    if (existsSync(targetPath))
        return [];
    const sourcePath = new URL("../skills/subagent-delegation/SKILL.md", import.meta.url);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), { mode: 0o644 });
    return [targetPath];
}
export function resolveSubagentsFlag(config, env = process.env) {
    if (env.DEVSPACE_SUBAGENTS === undefined)
        return config.subagents;
    return ["1", "true", "yes", "on"].includes(env.DEVSPACE_SUBAGENTS.toLowerCase());
}
function readJsonFile(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read ${filePath}: ${reason}`);
    }
}
function writeJsonFile(filePath, value, mode) {
    writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
