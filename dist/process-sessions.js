import { spawn } from "node:child_process";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
function boundedInteger(value, fallback, maximum) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Duration and output limits must be non-negative.");
    }
    return Math.min(Math.floor(value), maximum);
}
function terminalSize(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new Error("Terminal dimensions must be integers between 1 and 1000.");
    }
    return value;
}
function processEnvironment(input) {
    const environment = {
        ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        CODEX_CI: "1",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
        ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
    };
    for (const [name, value] of Object.entries(input?.environment || {})) {
        if (value === undefined || value === null)
            delete environment[name];
        else
            environment[name] = String(value);
    }
    return environment;
}
function codePointLength(value) {
    return Array.from(value).length;
}
function sliceCodePoints(value, start, end) {
    return Array.from(value).slice(start, end).join("");
}
function takeHead(value, count) {
    if (count <= 0)
        return "";
    return sliceCodePoints(value, 0, count);
}
function takeTail(value, count) {
    if (count <= 0)
        return "";
    const characters = Array.from(value);
    return characters.slice(Math.max(0, characters.length - count)).join("");
}
function splitBudget(maxCharacters) {
    return {
        head: Math.ceil(maxCharacters / 2),
        tail: Math.floor(maxCharacters / 2),
    };
}
function formatHeadTail(head, tail, omittedCharacters) {
    if (omittedCharacters <= 0)
        return head + tail;
    return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}
export class HeadTailBuffer {
    maxCharacters;
    head = "";
    tail = "";
    totalCharacters = 0;
    constructor(maxCharacters) {
        this.maxCharacters = maxCharacters;
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Head/tail buffer limit must be a positive integer.");
        }
    }
    append(output) {
        if (!output)
            return;
        const previousTotal = this.totalCharacters;
        this.totalCharacters += codePointLength(output);
        if (this.totalCharacters <= this.maxCharacters) {
            this.head += output;
            return;
        }
        const budget = splitBudget(this.maxCharacters);
        if (previousTotal <= this.maxCharacters) {
            const fullOutput = this.head + output;
            this.head = takeHead(fullOutput, budget.head);
            this.tail = takeTail(fullOutput, budget.tail);
            return;
        }
        this.tail = takeTail(this.tail + output, budget.tail);
    }
    hasOutput() {
        return this.totalCharacters > 0;
    }
    drain(maxCharacters) {
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Output limit must be a positive integer.");
        }
        const omittedByBuffer = Math.max(0, this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail));
        const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
        const output = truncateOutput(retained, maxCharacters);
        const truncated = omittedByBuffer > 0 || output.truncated;
        this.head = "";
        this.tail = "";
        this.totalCharacters = 0;
        return { output: output.output, truncated };
    }
}
function truncateOutput(output, maxCharacters) {
    const outputCharacters = codePointLength(output);
    if (outputCharacters <= maxCharacters)
        return { output, truncated: false };
    const marker = "\n... output truncated ...\n";
    const markerCharacters = codePointLength(marker);
    const available = Math.max(0, maxCharacters - markerCharacters);
    const budget = splitBudget(available);
    return {
        output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
        truncated: true,
    };
}
export class ProcessSessionManager {
    sessions = new Map();
    maxBufferCharacters;
    completedSessionTtlMs;
    nextSessionId = 1;
    constructor(options = {}) {
        this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
        this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    }
    async start(input) {
        const session = this.createSession(input);
        this.sessions.set(session.id, session);
        try {
            if (input.tty && process.platform !== "win32")
                await this.startPty(session, input);
            else
                this.startPipe(session, input);
        }
        catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }
        const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
        await this.waitForExit(session, yieldTimeMs);
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.removeSession(session.id);
        return snapshot;
    }
    async write(input) {
        const session = this.getOwnedSession(input.workspaceId, input.sessionId);
        const chars = input.chars ?? "";
        const interactionRequested = chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
        if (input.columns !== undefined || input.rows !== undefined) {
            session.columns = terminalSize(input.columns, session.columns);
            session.rows = terminalSize(input.rows, session.rows);
            if (!session.process?.resize) {
                throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
            }
            session.process.resize(session.columns, session.rows);
        }
        const interruptRequested = chars.includes("\u0003") && session.running;
        if (interruptRequested) {
            session.process?.kill("SIGINT");
        }
        const writableChars = chars.replaceAll("\u0003", "");
        if (writableChars && session.running)
            session.process?.write(writableChars);
        if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
            const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
            const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
            const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
            await this.waitForExit(session, yieldTimeMs);
        }
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.removeSession(session.id);
        return snapshot;
    }
    terminate(workspaceId, sessionId) {
        const session = this.getOwnedSession(workspaceId, sessionId);
        if (session.running)
            session.process?.kill("SIGTERM");
    }
    shutdown() {
        for (const session of this.sessions.values()) {
            if (session.cleanupTimer)
                clearTimeout(session.cleanupTimer);
            if (session.running)
                session.process?.kill("SIGTERM");
            this.disposeSession(session);
        }
        this.sessions.clear();
    }
    async waitForExit(session, yieldTimeMs) {
        let timer;
        try {
            await Promise.race([
                session.exitPromise,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, yieldTimeMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    createSession(input) {
        let resolveExit = () => undefined;
        const exitPromise = new Promise((resolve) => {
            resolveExit = resolve;
        });
        return {
            id: this.nextSessionId++,
            workspaceId: input.workspaceId,
            startedAt: Date.now(),
            columns: terminalSize(input.columns, DEFAULT_COLUMNS),
            rows: terminalSize(input.rows, DEFAULT_ROWS),
            buffer: new HeadTailBuffer(this.maxBufferCharacters),
            running: true,
            exitPromise,
            resolveExit,
            onDispose: typeof input.onDispose === "function" ? input.onDispose : undefined,
            disposed: false,
        };
    }
    startPipe(session, input) {
        const directExecutable = String(input.executable || "").trim();
        const shell = directExecutable ? null : resolveShellCommand(input.command);
        const detached = process.platform !== "win32";
        const child = directExecutable
            ? spawn(directExecutable, Array.isArray(input.args) ? input.args.map(String) : [], {
                cwd: input.cwd,
                env: processEnvironment({
                    workspaceId: input.workspaceId,
                    workspaceRoot: input.workspaceRoot,
                    environment: input.environment,
                }),
                stdio: "pipe",
                windowsHide: true,
                detached,
                shell: false,
            })
            : spawn(input.command, {
                cwd: input.cwd,
                env: processEnvironment({
                    workspaceId: input.workspaceId,
                    workspaceRoot: input.workspaceRoot,
                    environment: input.environment,
                }),
                stdio: "pipe",
                windowsHide: true,
                detached,
                shell: shell.executable,
            });
        session.process = {
            write: (data) => child.stdin.write(data),
            kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
            resize: input.tty ? () => undefined : undefined,
        };
        child.stdout.on("data", (data) => this.append(session, data.toString("utf8")));
        child.stderr.on("data", (data) => this.append(session, data.toString("utf8")));
        child.on("error", (error) => this.append(session, `${error.message}\n`));
        child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
    }
    async startPty(session, input) {
        let nodePty;
        try {
            nodePty = await import("node-pty");
        }
        catch {
            throw new Error("PTY support requires the optional node-pty dependency.");
        }
        const directExecutable = String(input.executable || "").trim();
        const shell = directExecutable
            ? { executable: directExecutable, args: Array.isArray(input.args) ? input.args.map(String) : [] }
            : resolveShellCommand(input.command);
        let pty;
        try {
            pty = nodePty.spawn(shell.executable, shell.args, {
                cwd: input.cwd,
                env: processEnvironment({
                    workspaceId: input.workspaceId,
                    workspaceRoot: input.workspaceRoot,
                    environment: input.environment,
                }),
                name: "xterm-256color",
                cols: session.columns,
                rows: session.rows,
            });
        }
        catch (error) {
            throw error;
        }
        session.process = {
            write: (data) => pty.write(data),
            kill: (signal) => pty.kill(signal),
            resize: (columns, rows) => pty.resize(columns, rows),
        };
        pty.onData((data) => this.append(session, data));
        pty.onExit(({ exitCode, signal }) => {
            this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
        });
    }
    finish(session, exitCode, signal) {
        if (!session.running)
            return;
        session.running = false;
        session.exitCode = exitCode;
        session.signal = signal;
        session.resolveExit();
        session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), this.completedSessionTtlMs);
        session.cleanupTimer.unref();
    }
    append(session, output) {
        session.buffer.append(output);
    }
    consume(session, maxOutputTokens) {
        const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
        const maxCharacters = Math.max(256, limit * 4);
        const buffered = session.buffer.drain(maxCharacters);
        return {
            sessionId: session.running ? session.id : undefined,
            output: buffered.output,
            outputTruncated: buffered.truncated,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            wallTimeMs: Date.now() - session.startedAt,
        };
    }
    getOwnedSession(workspaceId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown process session: ${sessionId}`);
        if (session.workspaceId !== workspaceId) {
            throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
        }
        return session;
    }
    disposeSession(session) {
        if (!session || session.disposed)
            return;
        session.disposed = true;
        try {
            const result = session.onDispose?.();
            result?.catch?.(() => {});
        }
        catch { }
    }
    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session?.cleanupTimer)
            clearTimeout(session.cleanupTimer);
        this.sessions.delete(sessionId);
        this.disposeSession(session);
    }
}
