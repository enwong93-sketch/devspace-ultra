import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSION_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function startsWith(buffer, bytes, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) return false;
  return bytes.every((value, index) => buffer[offset + index] === value);
}

export function detectImageMime(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (buffer?.subarray?.(0, 6).toString("ascii") === "GIF87a" || buffer?.subarray?.(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return null;
}

export async function loadImageForMcp(path, { maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  const limit = Number(maxBytes);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Image byte limit must be a positive integer.");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Image path must refer to a regular file.");
  if (info.size > limit) throw new Error(`Image exceeds the ${limit}-byte view limit.`);

  const extensionMime = EXTENSION_MIME.get(extname(path).toLowerCase());
  if (!extensionMime) throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");
  const data = await readFile(path);
  const detectedMime = detectImageMime(data);
  if (!detectedMime) throw new Error("Image signature is invalid or unsupported.");
  if (detectedMime !== extensionMime) throw new Error(`Image extension does not match its ${detectedMime} file signature.`);

  return {
    bytes: data.byteLength,
    mimeType: detectedMime,
    data: data.toString("base64"),
  };
}
