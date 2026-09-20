import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@devspace/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
function toMcpContent(result) {
    return result.content.map((content) => {
        if (content.type === "text") {
            return { type: "text", text: content.text };
        }
        return {
            type: "image",
            data: content.data,
            mimeType: content.mimeType,
        };
    });
}
function formatToolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ type: "text", text: message }];
}
async function runTool(execute, input, context) {
    try {
        const result = await execute(input);
        return {
            content: toMcpContent(result),
            details: result.details,
        };
    }
    catch (error) {
        return { content: formatToolError(error), isError: true };
    }
}
export async function readFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
    const tool = createReadTool(context.cwd);
    return runTool((params) => tool.execute("read_file", params), {
        path,
        offset: input.offset,
        limit: input.limit,
    }, context);
}
export async function writeFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createWriteTool(context.cwd);
    return runTool((params) => tool.execute("write_file", params), {
        path,
        content: input.content,
    }, context);
}
export async function editFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createEditTool(context.cwd);
    return runTool((params) => tool.execute("edit_file", params), {
        path,
        edits: input.edits,
    }, context);
}
export async function grepFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createGrepTool(context.cwd);
    return runTool((params) => tool.execute("grep_files", params), input, context);
}
export async function findFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createFindTool(context.cwd);
    return runTool((params) => tool.execute("find_files", params), input, context);
}
export async function listDirectoryTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createLsTool(context.cwd);
    return runTool((params) => tool.execute("list_directory", params), input, context);
}
export async function runShellTool(input, context) {
    const tool = createBashTool(context.cwd);
    return runTool((params) => tool.execute("run_shell", params), {
        command: input.command,
    }, context);
}
