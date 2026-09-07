import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { detectImageMime, DEFAULT_MAX_IMAGE_BYTES } from "./image-tools.js";
import { ArtifactError } from "./artifact-error.js";
import { IncomingArtifactAdapterRegistry } from "./incoming-artifacts.js";

const IMAGE_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const openAIFileReferenceInputSchema = z.strictObject({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

function incomingStreamChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new ArtifactError("invalid_incoming_image_chunk", "Incoming image stream yielded a value that is not bytes or text.");
}

function cleanFilename(value) {
  const text = typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim() : "";
  return text ? text.slice(0, 240) : null;
}

export async function loadIncomingImage({ registry, file, maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  if (!registry || typeof registry.open !== "function") throw new Error("Incoming image registry is required.");
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Incoming image byte limit must be a positive integer.");
  const opened = await registry.open(file);
  try {
    if (opened.size !== undefined && opened.size > limit) {
      throw new ArtifactError("incoming_image_too_large", `Attached image exceeds the ${limit}-byte inspection limit.`);
    }
    const chunks = [];
    let size = 0;
    for await (const value of opened.stream) {
      const chunk = incomingStreamChunk(value);
      if (size + chunk.length > limit) {
        throw new ArtifactError("incoming_image_too_large", `Attached image exceeds the ${limit}-byte inspection limit.`);
      }
      chunks.push(chunk);
      size += chunk.length;
    }
    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError("incoming_image_size_mismatch", "Attached image metadata did not match the downloaded content.");
    }
    const data = Buffer.concat(chunks, size);
    const mimeType = detectImageMime(data);
    if (!mimeType) throw new ArtifactError("incoming_image_invalid", "Attached file is not a valid PNG, JPEG, GIF, or WebP image.");
    const mimeHint = typeof opened.mimeType === "string" ? opened.mimeType.toLowerCase() : null;
    if (mimeHint?.startsWith("image/") && mimeHint !== mimeType) {
      throw new ArtifactError("incoming_image_mime_mismatch", `Attached image MIME metadata (${mimeHint}) does not match its ${mimeType} signature.`);
    }
    return {
      filename: cleanFilename(opened.filename ?? opened.name),
      mimeType,
      bytes: size,
      data,
    };
  } finally {
    opened.stream.destroy?.();
  }
}

function textError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      ok: false,
      error: message,
      errorCode: error instanceof ArtifactError ? error.code : "incoming_image_failed",
    },
  };
}

export function registerIncomingImageTools(server, {
  incomingArtifactAdapters = [],
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const registry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);
  registerAppTool(server, "inspect_attached_image", {
    title: "Inspect attached image",
    description: "Read one ChatGPT-native attached/generated PNG, JPEG, GIF, or WebP directly into model vision without shell commands, arbitrary URLs, local path guessing, or writing the file to disk. The host must supply the native authorized file value. Content is signature-validated and bounded to 20 MiB by default.",
    inputSchema: {
      file: openAIFileReferenceInputSchema.describe("Native image file value authorized and supplied by the MCP host."),
      detail: z.enum(["high", "original"]).optional().describe("Use original only when full source resolution is necessary."),
    },
    outputSchema: {
      ok: z.boolean(),
      filename: z.string().nullable().optional(),
      mimeType: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      detail: z.enum(["high", "original"]).optional(),
      route: z.literal("chatgpt-native-file").optional(),
      persistedToDisk: z.literal(false).optional(),
      error: z.string().optional(),
      errorCode: z.string().optional(),
    },
    _meta: { "openai/fileParams": ["file"] },
    annotations: IMAGE_READ_ANNOTATIONS,
  }, async ({ file, detail }) => {
    try {
      const image = await loadIncomingImage({ registry, file, maxBytes: maxImageBytes });
      const structuredContent = {
        ok: true,
        filename: image.filename,
        mimeType: image.mimeType,
        bytes: image.bytes,
        detail: detail || "high",
        route: "chatgpt-native-file",
        persistedToDisk: false,
      };
      return {
        content: [
          { type: "text", text: `Loaded attached image${image.filename ? ` ${image.filename}` : ""} (${image.mimeType}, ${image.bytes} bytes) through the authorized native-file route.` },
          { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
        ],
        structuredContent,
      };
    } catch (error) {
      return textError(error);
    }
  });
}
