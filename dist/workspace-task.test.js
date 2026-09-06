import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ProcessSessionManager } from "./process-sessions.js";
import { executeWorkspaceTask } from "./workspace-task.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workspace-task-"));
const workspace = { id: "ws_workspace_task_test", root };

function assertInsideRoot(path) {
    const relationship = relative(root, path);
    assert.ok(relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship)));
    return path;
}

const workspaces = {
    getWorkspace(workspaceId) {
        assert.equal(workspaceId, workspace.id);
        return workspace;
    },
    resolveReadPath(_workspace, inputPath) {
        return {
            absolutePath: assertInsideRoot(resolve(root, inputPath)),
            readRoots: [root],
        };
    },
    markReadPathLoaded() {},
    resolveWorkingDirectory(_workspace, workingDirectory) {
        return assertInsideRoot(workingDirectory ? resolve(root, workingDirectory) : root);
    },
};

const processSessions = new ProcessSessionManager();

try {
    writeFileSync(join(root, "input.txt"), "before\n", "utf8");

    const combined = await executeWorkspaceTask({
        workspaceId: workspace.id,
        operations: [
            { type: "read", path: "input.txt", label: "inspect fixture" },
            {
                type: "apply_patch",
                patch: "*** Begin Patch\n*** Update File: input.txt\n@@\n-before\n+after\n*** End Patch",
            },
            {
                type: "exec",
                cmd: "node -e \"process.stdout.write(require('fs').readFileSync('input.txt','utf8'))\"",
                label: "verify patched content",
            },
        ],
    }, { workspaces, processSessions });

    assert.equal(combined.ok, true);
    assert.equal(combined.completed, 3);
    assert.equal(combined.stoppedEarly, false);
    assert.equal(combined.operations[0]?.result.includes("before"), true);
    assert.equal(combined.operations[1]?.additions, 1);
    assert.equal(combined.operations[1]?.removals, 1);
    assert.equal(combined.operations[2]?.result.includes("after"), true);
    assert.equal(readFileSync(join(root, "input.txt"), "utf8"), "after\n");

    const stopped = await executeWorkspaceTask({
        workspaceId: workspace.id,
        operations: [
            { type: "read", path: "missing.txt" },
            {
                type: "apply_patch",
                patch: "*** Begin Patch\n*** Add File: should-not-exist.txt\n+blocked\n*** End Patch",
            },
        ],
    }, { workspaces, processSessions });

    assert.equal(stopped.ok, false);
    assert.equal(stopped.completed, 1);
    assert.equal(stopped.stoppedEarly, true);
    assert.equal(stopped.operations[0]?.ok, false);
    assert.throws(() => readFileSync(join(root, "should-not-exist.txt"), "utf8"));

    const continued = await executeWorkspaceTask({
        workspaceId: workspace.id,
        stopOnError: false,
        operations: [
            { type: "read", path: "still-missing.txt" },
            { type: "exec", cmd: "node -e \"process.stdout.write('continued')\"" },
        ],
    }, { workspaces, processSessions });

    assert.equal(continued.ok, false);
    assert.equal(continued.completed, 2);
    assert.equal(continued.stoppedEarly, false);
    assert.equal(continued.operations[1]?.ok, true);
    assert.equal(continued.operations[1]?.result.includes("continued"), true);

    const failedCommand = await executeWorkspaceTask({
        workspaceId: workspace.id,
        operations: [
            { type: "exec", cmd: "node -e \"process.exit(7)\"" },
            {
                type: "apply_patch",
                patch: "*** Begin Patch\n*** Add File: command-stop.txt\n+blocked\n*** End Patch",
            },
        ],
    }, { workspaces, processSessions });

    assert.equal(failedCommand.ok, false);
    assert.equal(failedCommand.operations[0]?.exitCode, 7);
    assert.equal(failedCommand.stoppedEarly, true);
    assert.throws(() => readFileSync(join(root, "command-stop.txt"), "utf8"));

    console.log(JSON.stringify({ ok: true, gate: "workspace-task", tests: 4 }));
}
finally {
    processSessions.shutdown();
    rmSync(root, { recursive: true, force: true });
}
