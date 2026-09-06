import { randomUUID } from "node:crypto";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { createManagedWorktree } from "./git-worktrees.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import { loadWorkspaceSkills, markSkillActivated, resolveSkillReadPath, } from "./skills.js";
import { loadLocalAgentProfiles, } from "./local-agent-profiles.js";
const DEFAULT_MAX_IN_MEMORY_WORKSPACES = 32;
export class WorkspaceRegistry {
    config;
    store;
    workspaces = new Map();
    maxInMemoryWorkspaces;
    constructor(config, store, options = {}) {
        this.config = config;
        this.store = store;
        this.maxInMemoryWorkspaces = Math.max(1, Math.min(512, Number(options.maxInMemoryWorkspaces) || DEFAULT_MAX_IN_MEMORY_WORKSPACES));
    }
    get inMemorySize() {
        return this.workspaces.size;
    }
    rememberWorkspace(workspace) {
        if (!workspace?.id)
            throw new Error("Workspace context requires id.");
        this.workspaces.delete(workspace.id);
        this.workspaces.set(workspace.id, workspace);
        while (this.workspaces.size > this.maxInMemoryWorkspaces) {
            const oldest = this.workspaces.keys().next().value;
            if (!oldest)
                break;
            this.workspaces.delete(oldest);
        }
        return workspace;
    }
    touchWorkspaceMemory(workspaceId) {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace)
            return undefined;
        this.workspaces.delete(workspaceId);
        this.workspaces.set(workspaceId, workspace);
        return workspace;
    }
    async openWorkspace(input) {
        const options = typeof input === "string" ? { path: input } : input;
        const mode = options.mode ?? "checkout";
        if (mode === "worktree") {
            return this.openWorktreeWorkspace(options.path, options.baseRef);
        }
        return this.openCheckoutWorkspace(options.path);
    }
    getWorkspace(workspaceId) {
        const workspace = this.touchWorkspaceMemory(workspaceId);
        if (workspace) {
            this.store?.touchSession(workspaceId);
            return workspace;
        }
        const session = this.store?.getSession(workspaceId);
        if (!session) {
            throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
        }
        const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
        const restoredWorkspace = {
            id: session.id,
            root,
            mode: session.mode,
            sourceRoot: session.sourceRoot,
            worktree: session.mode === "worktree"
                ? {
                    path: root,
                    baseRef: session.baseRef ?? "HEAD",
                    baseSha: session.baseSha ?? "",
                    dirtySource: false,
                    detached: true,
                    managed: session.managed,
                }
                : undefined,
            ...this.loadSkillsForWorkspace(root),
            agentProfiles: [],
            activatedSkillDirs: new Set(),
        };
        this.store?.touchSession(workspaceId);
        this.rememberWorkspace(restoredWorkspace);
        return restoredWorkspace;
    }
    resolvePath(workspace, inputPath) {
        const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
        if (!isPathInsideRoot(absolutePath, workspace.root)) {
            throw new Error(`Path is outside workspace root: ${inputPath}`);
        }
        return absolutePath;
    }
    resolveReadPath(workspace, inputPath) {
        try {
            return {
                absolutePath: this.resolvePath(workspace, inputPath),
                readRoots: [workspace.root],
            };
        }
        catch (workspaceError) {
            const skillRead = resolveSkillReadPath(workspace.skills, workspace.activatedSkillDirs, inputPath);
            if (!skillRead)
                throw workspaceError;
            return {
                absolutePath: skillRead.absolutePath,
                readRoots: [workspace.root, skillRead.skill.baseDir],
                skillRead,
            };
        }
    }
    markReadPathLoaded(workspace, readPath) {
        if (readPath.skillRead?.isSkillFile) {
            markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
        }
    }
    resolveWorkingDirectory(workspace, workingDirectory) {
        const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
        return assertAllowedPath(directory, [workspace.root]);
    }
    async openCheckoutWorkspace(path) {
        const root = assertAllowedPath(path, this.config.allowedRoots);
        const rootStats = await ensureCheckoutWorkspaceRoot(root);
        if (!rootStats.isDirectory()) {
            throw new Error(`Workspace root must be a directory: ${path}`);
        }
        return this.createWorkspaceContext({ root, mode: "checkout" });
    }
    async openWorktreeWorkspace(path, baseRef) {
        const worktree = await createManagedWorktree({
            sourcePath: path,
            baseRef,
            config: this.config,
        });
        return this.createWorkspaceContext({
            root: worktree.path,
            mode: "worktree",
            sourceRoot: worktree.sourceRoot,
            worktree,
        });
    }
    async createWorkspaceContext(input) {
        const workspace = {
            id: `ws_${randomUUID()}`,
            root: input.root,
            mode: input.mode,
            sourceRoot: input.sourceRoot,
            worktree: input.worktree,
            ...this.loadSkillsForWorkspace(input.root),
            agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
            activatedSkillDirs: new Set(),
        };
        this.store?.createSession({
            id: workspace.id,
            root: workspace.root,
            mode: workspace.mode,
            sourceRoot: workspace.sourceRoot,
            baseRef: workspace.worktree?.baseRef,
            baseSha: workspace.worktree?.baseSha,
            managed: workspace.worktree?.managed,
        });
        this.rememberWorkspace(workspace);
        const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);
        return { workspace, agentsFiles, availableAgentsFiles };
    }
    loadSkillsForWorkspace(root) {
        const result = loadWorkspaceSkills(this.config, root);
        return {
            skills: result.skills,
            skillDiagnostics: result.diagnostics,
        };
    }
    assertWorkspaceRootAllowed(root, mode, sourceRoot) {
        if (mode === "worktree") {
            if (!sourceRoot) {
                throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
            }
            assertAllowedPath(sourceRoot, this.config.allowedRoots);
            return assertAllowedPath(root, [this.config.worktreeRoot]);
        }
        return assertAllowedPath(root, this.config.allowedRoots);
    }
    async loadInitialAgentsFiles(root) {
        const agentDir = resolve(this.config.agentDir);
        const resolvedRoot = (await tryRealpath(root)) ?? root;
        const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
        const loadedFiles = [];
        for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
            const path = resolve(file.path);
            if (!isInitialAgentsFilePath(path, root, agentDir))
                continue;
            const content = await readResolvedContextFile(path, file.content, resolvedRoot, resolvedAgentDir);
            if (content === undefined)
                continue;
            loadedFiles.push({
                path,
                content,
            });
        }
        return loadedFiles;
    }
    async findAvailableAgentsFiles(root, loadedFiles) {
        const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
        const loadedRealPaths = new Set();
        for (const file of loadedFiles) {
            const realPath = await tryRealpath(file.path);
            if (realPath)
                loadedRealPaths.add(realPath);
        }
        const discovered = [];
        await walkWorkspace(root, async (path, entry) => {
            if (!entry.isFile())
                return;
            if (!CONTEXT_FILE_NAMES.has(entry.name))
                return;
            if (loadedPaths.has(path))
                return;
            const realPath = await tryRealpath(path);
            if (realPath && loadedRealPaths.has(realPath))
                return;
            discovered.push({ path });
        });
        return discovered.sort((a, b) => a.path.localeCompare(b.path));
    }
}
export async function ensureCheckoutWorkspaceRoot(path, ops = { stat, mkdir }) {
    try {
        return await ops.stat(path);
    }
    catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
    await ops.mkdir(path, { recursive: true });
    return await ops.stat(path);
}
const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    ".devspace",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
]);
export function formatAgentsPath(path, workspaceRoot) {
    if (!workspaceRoot)
        return path.split(sep).join("/");
    const relationship = relative(workspaceRoot, path);
    if (relationship === "" ||
        relationship.startsWith("..") ||
        relationship === ".." ||
        relationship.includes(`..${sep}`)) {
        return path.split(sep).join("/");
    }
    return relationship.split(sep).join("/");
}
function isInitialAgentsFilePath(path, root, agentDir) {
    if (isPathInsideRoot(path, agentDir))
        return true;
    return isPathInsideRoot(path, root) && dirname(path) === root;
}
async function readResolvedContextFile(path, fallbackContent, root, agentDir) {
    try {
        const resolvedPath = await realpath(path);
        if (!isInitialAgentsFilePath(resolvedPath, root, agentDir))
            return undefined;
        return await readFile(resolvedPath, "utf8");
    }
    catch {
        return fallbackContent;
    }
}
async function tryRealpath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return undefined;
    }
}
async function walkWorkspace(directory, visit) {
    let entries;
    try {
        entries = await opendir(directory);
    }
    catch {
        return;
    }
    for await (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
                await walkWorkspace(path, visit);
            }
            continue;
        }
        await visit(path, entry);
    }
}
function isErrnoException(error) {
    return error instanceof Error && "code" in error;
}
