import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, } from "@devspace/pi-coding-agent";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
import { installedCapabilitySkillPaths } from "./capability-runtime.js";
const SUBAGENT_DELEGATION_NAME = "subagent-delegation";
const SUBAGENT_DELEGATION_SKILL = join(SUBAGENT_DELEGATION_NAME, "SKILL.md");
function isNonBlockingSkillCollision(collision) {
    if (collision?.resourceType !== "skill")
        return false;
    const winner = String(collision.winnerPath || "").replace(/\\/g, "/").toLowerCase();
    const loser = String(collision.loserPath || "").replace(/\\/g, "/").toLowerCase();
    const mirror = (value) => value.replace(/\/(?:\.claude|\.cursor)\/skills\//, "/<platform-mirror>/skills/");
    // arjun988 packages intentionally mirror the same immutable skill tree for
    // Claude and Cursor. The deterministic winner remains the .claude copy.
    if (mirror(winner) === mirror(loser) && /\/<platform-mirror>\/skills\//.test(mirror(winner)))
        return true;
    // A user-installed skill deliberately takes precedence over a bundled or
    // cached plugin copy. It is an authority decision, not a parse failure.
    const userWinner = /\/(?:\.codex|\.agents)\/skills\//.test(winner);
    const managedLoser = /\/(?:plugins\/packages|\.codex\/plugins\/cache)\//.test(loser);
    if (userWinner && managedLoser)
        return true;
    // The local .agents tree is the explicit primary layer. The parallel
    // .codex copy is a compatibility mirror, not an ambiguous authority.
    return /\/\.agents\/skills\//.test(winner) && /\/\.codex\/skills\//.test(loser);
}
function bundledSkillsDir() {
    return fileURLToPath(new URL("../skills", import.meta.url));
}
function hasSubagentDelegationSkill(skillDir) {
    return existsSync(join(skillDir, SUBAGENT_DELEGATION_SKILL));
}
export function effectiveSkillPaths(config, cwd) {
    const bundledSkills = bundledSkillsDir();
    const defaultPathCandidates = [
        join(homedir(), ".agents", "skills"),
        resolve(cwd, ".agents", "skills"),
        config.devspaceSkillsDir,
        join(config.agentDir, "skills"),
        ...installedCapabilitySkillPaths(config),
        config.subagents && !hasSubagentDelegationSkill(config.devspaceSkillsDir)
            ? bundledSkills
            : undefined,
    ];
    const defaultPaths = defaultPathCandidates.filter((path) => path !== undefined && existsSync(path));
    const seen = new Set();
    return [...defaultPaths, ...config.skillPaths]
        .map((path) => resolveSkillPath(path, cwd))
        .filter((path) => {
        if (seen.has(path))
            return false;
        seen.add(path);
        return true;
    });
}
function resolveSkillPath(path, cwd) {
    return resolve(cwd, expandHomePath(path));
}
export function loadWorkspaceSkills(config, cwd) {
    if (!config.skillsEnabled)
        return { skills: [], diagnostics: [] };
    const result = loadSkills({
        cwd,
        agentDir: config.agentDir,
        skillPaths: effectiveSkillPaths(config, cwd),
        includeDefaults: false,
    });
    if (config.subagents)
        return result;
    return {
        skills: result.skills.filter((skill) => skill.name !== SUBAGENT_DELEGATION_NAME),
        diagnostics: result.diagnostics.filter((diagnostic) => {
            const collision = diagnostic.collision;
            return !(collision?.resourceType === "skill" && collision.name === SUBAGENT_DELEGATION_NAME)
                && !isNonBlockingSkillCollision(collision);
        }),
    };
}
export function resolveSkillReadPath(skills, activatedSkillDirs, inputPath) {
    const absolutePath = resolve(expandHomePath(inputPath));
    for (const skill of skills) {
        const skillFilePath = resolve(skill.filePath);
        if (absolutePath === skillFilePath) {
            return { absolutePath, skill, isSkillFile: true };
        }
    }
    for (const skill of skills) {
        const baseDir = resolve(skill.baseDir);
        if (!activatedSkillDirs.has(baseDir))
            continue;
        if (!isPathInsideRoot(absolutePath, baseDir))
            continue;
        return { absolutePath, skill, isSkillFile: false };
    }
    return undefined;
}
export function markSkillActivated(activatedSkillDirs, skill) {
    activatedSkillDirs.add(resolve(skill.baseDir));
}
export function formatPathForPrompt(path) {
    const home = resolve(homedir());
    const resolvedPath = resolve(path);
    if (resolvedPath === home)
        return "~";
    if (resolvedPath.startsWith(`${home}${sep}`)) {
        return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
    }
    return resolvedPath.split(sep).join("/");
}
