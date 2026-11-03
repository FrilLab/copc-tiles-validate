import { open, stat } from "node:fs/promises";

async function readBytes(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await handle.read(buffer, read, length - read, position + read);
    if (part.bytesRead === 0) throw new Error("Unexpected end of file");
    read += part.bytesRead;
  }
  return buffer;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeByteLength(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function inspectGlb(filePath, ctx) {
  const { error, warn, options } = ctx;
  const target = filePath;
  const size = (await stat(filePath)).size;
  if (size < 20) {
    error("GLB_HEADER", target, "GLB header or first chunk is truncated");
    return;
  }
  if (size > options.maxFileBytes) {
    error("FILE_LIMIT", target, "File exceeds maxFileBytes");
    return;
  }
  const handle = await open(filePath, "r");
  try {
    const header = await readBytes(handle, 0, 12);
    if (header.toString("ascii", 0, 4) !== "glTF") {
      error("GLB_MAGIC", target, "Expected glTF magic");
      return;
    }
    if (header.readUInt32LE(4) !== 2) {
      error("GLB_VERSION", target, "Only binary glTF version 2 is supported");
      return;
    }
    if (header.readUInt32LE(8) !== size) {
      error("GLB_LENGTH", target, "Declared GLB length does not match file size");
      return;
    }
    let offset = 12;
    let index = 0;
    let json = null;
    let binaryLength = 0;
    while (offset < size) {
      if (size - offset < 8) {
        error("GLB_CHUNK_HEADER", target, "Truncated GLB chunk header");
        return;
      }
      const chunkHeader = await readBytes(handle, offset, 8);
      const length = chunkHeader.readUInt32LE(0);
      const type = chunkHeader.toString("ascii", 4, 8);
      offset += 8;
      if (length % 4 !== 0 || length > size - offset) {
        error("GLB_CHUNK_LENGTH", target, "Invalid GLB chunk length or alignment");
        return;
      }
      if (index === 0) {
        if (type !== "JSON") {
          error("GLB_JSON_CHUNK", target, "First GLB chunk must be JSON");
          return;
        }
        if (length > options.maxJsonBytes) {
          error("JSON_LIMIT", target, "GLB JSON chunk exceeds maxJsonBytes");
          return;
        }
        const bytes = await readBytes(handle, offset, length);
        try {
          json = JSON.parse(bytes.toString("utf8").trim());
        } catch {
          error("GLB_JSON_PARSE", target, "Invalid GLB JSON chunk");
          return;
        }
      } else if (index === 1 && type === "BIN\u0000") {
        binaryLength = length;
      } else {
        warn("GLB_CHUNK_UNVERIFIED", target, "Non-standard or additional GLB chunk not semantically checked");
      }
      offset += length;
      index++;
    }
    if (!isRecord(json) || !isRecord(json.asset) || json.asset.version !== "2.0") {
      error("GLTF_ASSET", target, "GLB JSON must contain asset.version 2.0");
      return;
    }
    if (Array.isArray(json.buffers)) {
      for (let i = 0; i < json.buffers.length; i++) {
        const buffer = json.buffers[i];
        if (!isRecord(buffer) || !safeByteLength(buffer.byteLength)) {
          error("GLTF_BUFFER_LENGTH", target, "Invalid glTF buffer byteLength");
        } else if (i === 0 && buffer.uri === undefined && buffer.byteLength > binaryLength) {
          error("GLTF_BUFFER_RANGE", target, "Embedded buffer is larger than BIN chunk");
        } else if (buffer.uri !== undefined) {
          warn("GLTF_EXTERNAL_RESOURCE", target, "External glTF buffer references are not checked");
        }
      }
    }
    warn("GLTF_SEMANTICS_UNVERIFIED", target, "Use Khronos glTF Validator for full glTF semantic conformance");
  } finally {
    await handle.close();
  }
}

function validateAvailability(record, label, ctx, filePath, viewCount) {
  if (!isRecord(record)) {
    ctx.error("SUBTREE_AVAILABILITY", filePath, label + " must be an object");
    return;
  }
  const constant = record.constant;
  const bitstream = record.bitstream;
  if (constant === undefined && bitstream === undefined) {
    ctx.error("SUBTREE_AVAILABILITY", filePath, label + " needs constant or bitstream");
    return;
  }
  if (constant !== undefined && bitstream !== undefined) {
    ctx.error("SUBTREE_AVAILABILITY", filePath, label + " cannot define both constant and bitstream");
  }
  if (constant !== undefined && constant !== 0 && constant !== 1) {
    ctx.error("SUBTREE_CONSTANT", filePath, label + " constant must be 0 or 1");
  }
  if (bitstream !== undefined && (!Number.isSafeInteger(bitstream) || bitstream < 0 || bitstream >= viewCount)) {
    ctx.error("SUBTREE_BITSTREAM", filePath, label + " references an invalid bufferView");
  }
}

export async function inspectSubtree(filePath, ctx) {
  const { error, warn, options } = ctx;
  const size = (await stat(filePath)).size;
  if (size < 24) {
    error("SUBTREE_HEADER", filePath, "Binary subtree header is truncated");
    return;
  }
  if (size > options.maxFileBytes) {
    error("FILE_LIMIT", filePath, "File exceeds maxFileBytes");
    return;
  }
  const handle = await open(filePath, "r");
  try {
    const header = await readBytes(handle, 0, 24);
    if (header.toString("ascii", 0, 4) !== "subt" || header.readUInt32LE(4) !== 1) {
      error("SUBTREE_MAGIC_VERSION", filePath, "Expected binary subtree magic subt, version 1");
      return;
    }
    const jsonLength = header.readBigUInt64LE(8);
    const binLength = header.readBigUInt64LE(16);
    if (jsonLength > BigInt(options.maxJsonBytes) || jsonLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      error("JSON_LIMIT", filePath, "Subtree JSON exceeds maxJsonBytes or safe integer range");
      return;
    }
    if (binLength > BigInt(Number.MAX_SAFE_INTEGER) ||
        24n + jsonLength + binLength !== BigInt(size)) {
      error("SUBTREE_LENGTH", filePath, "Subtree chunk lengths do not match file size");
      return;
    }
    if (jsonLength % 8n !== 0n || binLength % 8n !== 0n) {
      error("SUBTREE_ALIGNMENT", filePath, "Subtree chunk lengths must be 8-byte aligned");
      return;
    }
    const bytes = await readBytes(handle, 24, Number(jsonLength));
    let json;
    try {
      json = JSON.parse(bytes.toString("utf8").trim());
    } catch {
      error("SUBTREE_JSON_PARSE", filePath, "Malformed subtree JSON");
      return;
    }
    if (!isRecord(json)) {
      error("SUBTREE_JSON", filePath, "Subtree JSON must be an object");
      return;
    }
    const views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
    const buffers = Array.isArray(json.buffers) ? json.buffers : [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      if (!isRecord(view) || !safeByteLength(view.byteLength) ||
          (view.byteOffset !== undefined && !safeByteLength(view.byteOffset)) ||
          !Number.isSafeInteger(view.buffer) || view.buffer < 0 ||
          view.buffer >= buffers.length) {
        error("SUBTREE_BUFFER_VIEW", filePath, "Invalid bufferView at index " + i);
        continue;
      }
      const buffer = buffers[view.buffer];
      const offset = view.byteOffset ?? 0;
      if (!isRecord(buffer) || !safeByteLength(buffer.byteLength) ||
          offset + view.byteLength > buffer.byteLength) {
        error("SUBTREE_BUFFER_VIEW_RANGE", filePath, "bufferView exceeds declared buffer");
      }
    }
    if (buffers.length > 0 && buffers[0].uri === undefined &&
        buffers[0].byteLength > Number(binLength)) {
      error("SUBTREE_BUFFER_RANGE", filePath, "Embedded buffer exceeds binary chunk");
    }
    validateAvailability(json.tileAvailability, "tileAvailability", ctx, filePath, views.length);
    const contents = Array.isArray(json.contentAvailability)
      ? json.contentAvailability : [json.contentAvailability];
    for (let i = 0; i < contents.length; i++) {
      validateAvailability(contents[i], "contentAvailability[" + i + "]", ctx, filePath, views.length);
    }
    validateAvailability(json.childSubtreeAvailability, "childSubtreeAvailability", ctx, filePath, views.length);
    warn("SUBTREE_SEMANTICS_UNVERIFIED", filePath,
      "Availability bit counts and cross-subtree semantics are not fully validated");
  } finally {
    await handle.close();
  }
}
