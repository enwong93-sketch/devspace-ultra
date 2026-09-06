import { applyPatch } from "./apply-patch.js";
import { readFileTool } from "./pi-tools.js";

function contentText(content = []) {
    return content
        .map((block) => block.type === "text"
        ? block.text
        : `[${block.mimeType ?? "image"} image payload]`)
        .filter(Boolean)
        .join("\n");
}

function processResult(snapshot) {
    const status = snapshot.running
        ? `Process running with session ID ${snapshot.sessionId}.`
        : snapshot.signal
            ? `Process exited after signal ${snapshot.signal}.`
            : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
    return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function operationLabel(operation, index) {
    if (operation.label)
        return operation.label;
    if (operation.type === "read")
        return operation.path;
    if (operation.type === "exec")
        return operation.cmd;
    if (operation.type === "write_stdin")
        return `session ${operation.sessionId}`;
    return `operation ${index + 1}`;
}

function formatOperationResult(operation, result) {
    const status = result.ok ? "ok" : "failed";
    const label = operationLabel(operation, result.index);
    return `[${result.index + 1} ${operation.type} ${status}] ${label}\n${result.result}`;
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

async function executeRead(workspaces, workspace, operation) {
    const readPath = workspaces.resolveReadPath(workspace, operation.path);
    const response = await readFileTool({
        path: readPath.absolutePath,
        offset: operation.offset,
        limit: operation.limit,
    }, {
        cwd: workspace.root,
        root: workspace.root,
        readRoots: readPath.readRoots,
    });
    if (!response.isError)
        workspaces.markReadPathLoaded(workspace, readPath);
    return {
        ok: response.isError !== true,
        result: contentText(response.content),
        path: operation.path,
    };
}

async function executeCommand(workspaces, processSessions, workspace, workspaceId, operation) {
    const cwd = workspaces.resolveWorkingDirectory(workspace, operation.workingDirectory);
    const snapshot = await processSessions.start({
        workspaceId,
        command: operation.cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty: operation.tty,
        columns: operation.columns,
        rows: operation.rows,
        yieldTimeMs: operation.yieldTimeMs,
        maxOutputTokens: operation.maxOutputTokens,
    });
    return {
        ok: snapshot.running || snapshot.exitCode === 0,
        result: processResult(snapshot),
        sessionId: snapshot.sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        wallTimeMs: snapshot.wallTimeMs,
        outputTruncated: snapshot.outputTruncated,
    };
}

async function executeProcessWrite(processSessions, workspaceId, operation) {
    const snapshot = await processSessions.write({
        workspaceId,
        sessionId: operation.sessionId,
        chars: operation.chars,
        columns: operation.columns,
        rows: operation.rows,
        yieldTimeMs: operation.yieldTimeMs,
        maxOutputTokens: operation.maxOutputTokens,
    });
    return {
        ok: snapshot.running || snapshot.exitCode === 0,
        result: processResult(snapshot),
        sessionId: snapshot.sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        wallTimeMs: snapshot.wallTimeMs,
        outputTruncated: snapshot.outputTruncated,
    };
}

async function executePatch(workspace, operation) {
    const applied = await applyPatch(workspace.root, operation.patch);
    const paths = applied.files.map((file) => file.path).join(", ");
    return {
        ok: true,
        result: `Applied patch to ${applied.files.length} file(s): ${paths}`,
        additions: applied.additions,
        removals: applied.removals,
        files: applied.files,
    };
}

/**
 * Execute a bounded sequence of ordinary DevSpace workspace operations behind
 * one MCP invocation. This intentionally does not embed an LLM or infer new
 * operations from prior output: the caller remains the reasoning loop, while
 * independent reads/commands and already-known edit+verification sequences can
 * be collapsed into one visible host tool call.
 */
export async function executeWorkspaceTask(input, dependencies) {
    const { workspaces, processSessions } = dependencies;
    const workspace = workspaces.getWorkspace(input.workspaceId);
    const stopOnError = input.stopOnError !== false;
    const operations = [];
    let stoppedEarly = false;

    for (let index = 0; index < input.operations.length; index += 1) {
        const operation = input.operations[index];
        const startedAt = performance.now();
        let result;
        try {
            switch (operation.type) {
                case "read":
                    result = await executeRead(workspaces, workspace, operation);
                    break;
                case "exec":
                    result = await executeCommand(workspaces, processSessions, workspace, input.workspaceId, operation);
                    break;
                case "write_stdin":
                    result = await executeProcessWrite(processSessions, input.workspaceId, operation);
                    break;
                case "apply_patch":
                    result = await executePatch(workspace, operation);
                    break;
                default:
                    throw new Error(`Unsupported workspace task operation: ${operation.type}`);
            }
        }
        catch (error) {
            result = {
                ok: false,
                result: errorMessage(error),
            };
        }

        operations.push({
            index,
            type: operation.type,
            label: operation.label,
            durationMs: Math.round(performance.now() - startedAt),
            ...result,
        });

        if (!result.ok && stopOnError) {
            stoppedEarly = index < input.operations.length - 1;
            break;
        }
    }

    const ok = operations.length === input.operations.length && operations.every((operation) => operation.ok);
    const completed = operations.length;
    const total = input.operations.length;
    const header = ok
        ? `Workspace task completed ${completed}/${total} operation(s).`
        : `Workspace task completed ${completed}/${total} operation(s) with failure${stoppedEarly ? " and stopped early" : ""}.`;
    const details = operations.map((result) => formatOperationResult(input.operations[result.index], result));

    return {
        ok,
        stoppedEarly,
        completed,
        total,
        result: [header, ...details].join("\n\n"),
        operations,
    };
}
