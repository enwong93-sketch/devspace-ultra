import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImageMime, loadImageForMcp } from "./image-tools.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_MINIMAL = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const WEBP_HEADER = Buffer.from("524946460400000057454250", "hex");
const GIF_HEADER = Buffer.from("GIF89a", "ascii");

assert.equal(detectImageMime(PNG_1X1), "image/png");
assert.equal(detectImageMime(JPEG_MINIMAL), "image/jpeg");
assert.equal(detectImageMime(WEBP_HEADER), "image/webp");
assert.equal(detectImageMime(GIF_HEADER), "image/gif");
assert.equal(detectImageMime(Buffer.from("not-an-image")), null);

const root = await mkdtemp(join(tmpdir(), "devspace-image-tool-"));
try {
  const pngPath = join(root, "pixel.png");
  await writeFile(pngPath, PNG_1X1);
  const loaded = await loadImageForMcp(pngPath);
  assert.equal(loaded.mimeType, "image/png");
  assert.equal(loaded.bytes, PNG_1X1.byteLength);
  assert.equal(Buffer.from(loaded.data, "base64").equals(PNG_1X1), true);

  const spoofed = join(root, "spoofed.jpg");
  await writeFile(spoofed, PNG_1X1);
  await assert.rejects(() => loadImageForMcp(spoofed), /extension does not match/i);

  const textPath = join(root, "payload.png");
  await writeFile(textPath, "not an image");
  await assert.rejects(() => loadImageForMcp(textPath), /signature is invalid/i);

  await assert.rejects(() => loadImageForMcp(pngPath, { maxBytes: PNG_1X1.byteLength - 1 }), /exceeds/i);

  const unsupported = join(root, "vector.svg");
  await writeFile(unsupported, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  await assert.rejects(() => loadImageForMcp(unsupported), /unsupported image type/i);

  console.log(JSON.stringify({
    ok: true,
    gate: "image-tools",
    supported: ["png", "jpeg", "webp", "gif"],
    signatureValidated: true,
    boundedBytes: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
