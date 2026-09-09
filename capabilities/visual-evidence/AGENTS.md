# Visual Evidence Readback

Use this capability for image readback, large Blender renders, source/model comparison and saved visual evidence. It is not an image generator or an aesthetics model.

## Exact workflow

1. Call image_prepare for a specific existing render or reference. The source remains unchanged. The result has dimensions, input hash, a bounded PNG path and a receipt id.
2. Call native DevSpace read with the CURRENT project's workspaceId and the returned preview_path. Confirm the response contains actual visible pixels, not merely `Read image file` text. A successful prepare response does not prove the host displayed an image.
3. Review the image with agent vision. For reference work call image_compare, then read its returned preview_path. Side-by-side mode preserves aspect; it is NOT proof of registration. registered_overlay requires equal pixel canvases and a recorded fixed camera/scale contract; never silently stretch or mirror the source.
4. Call image_review_record with the exact preview hash and concrete observations. FAIL if likeness regressed even when topology passed. INCONCLUSIVE when pixels did not arrive. Stale source/preview hashes block recording.
5. After failure to read a large source, use one small bounded derivative (max_edge=768) and retry native read once. If no image is visible, stop visual grading, preserve receipts and report the transport failure. Never disable safety checks or claim success from file existence or hashes alone.

## Safety and compatibility

Only projects explicitly in roots.json are accessible. No arbitrary root arguments, network, credentials, shell or remote URLs. Output is isolated in each project's .visual-evidence directory, unique filenames, no overwritten source images. Crop, uniform scale, PNG encoding and labelled comparison only; no retouching or generative redrawing.

This works through existing capability_call plus read, without restarting DevSpace or adding a client-side schema. The installed gateway's generic capability_call currently wraps runtime.call in textResult; nested MCP image blocks may be JSON-stringified. Therefore return a concise receipt and use the already image-capable native read transport. This is a verified alternative path, not a claim to repair every possible host transport fault.

Reference implementation uses the MCP image-content distinction from https://modelcontextprotocol.io/specification/2025-06-18/server/tools . No model inference quota is used by these local adapters.
