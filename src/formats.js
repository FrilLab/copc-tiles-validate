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
  const { error, warn, options, cover } = ctx;
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
    let json = null;
    let binaryLength = 0;
    let seenJson = false;
    let seenBinary = false;
    let seenUnknown = false;
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
      if (!seenJson) {
        if (type !== "JSON") {
          error("GLB_JSON_CHUNK", target, "First GLB chunk must be JSON");
          return;
        }
        seenJson = true;
        if (length === 0) {
          error("GLB_JSON_CHUNK", target, "GLB JSON chunk must not be empty");
          return;
        }
        if (length > options.maxJsonBytes) {
          error("JSON_LIMIT", target, "GLB JSON chunk exceeds maxJsonBytes");
          return;
        }
        const bytes = await readBytes(handle, offset, length);
        try {
          json = JSON.parse(bytes.toString("utf8"));
        } catch {
          error("GLB_JSON_PARSE", target, "Invalid GLB JSON chunk");
          return;
        }
      } else if (type === "JSON") {
        error("GLB_CHUNK_ORDER", target, "GLB may contain exactly one JSON chunk, first");
        return;
      } else if (type === "BIN\u0000") {
        if (seenBinary || seenUnknown) {
          error("GLB_CHUNK_ORDER", target, "BIN chunk must occur at most once and before unknown chunks");
          return;
        }
        seenBinary = true;
        binaryLength = length;
      } else {
        seenUnknown = true;
        warn("GLB_CHUNK_UNVERIFIED", target, "Non-standard or additional GLB chunk not semantically checked");
        cover("partial", "glb-extension-chunk", target, "Unknown GLB chunk contents are ignored");
      }
      offset += length;
    }
    if (!seenJson) {
      error("GLB_JSON_CHUNK", target, "GLB must contain a JSON chunk");
      return;
    }
    if (!isRecord(json) || !isRecord(json.asset) || json.asset.version !== "2.0") {
      error("GLTF_ASSET", target, "GLB JSON must contain asset.version 2.0");
      return;
    }
    if (json.buffers !== undefined &&
        (!Array.isArray(json.buffers) || json.buffers.length === 0)) {
      error("GLTF_BUFFERS", target, "buffers must be a nonempty array when present");
    } else if (Array.isArray(json.buffers)) {
      for (let i = 0; i < json.buffers.length; i++) {
        const buffer = json.buffers[i];
        if (!isRecord(buffer) || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 1) {
          error("GLTF_BUFFER_LENGTH", target, "Each glTF buffer needs a positive safe integer byteLength");
          continue;
        }
        if (buffer.uri !== undefined && (typeof buffer.uri !== "string" || buffer.uri.length === 0)) {
          error("GLTF_BUFFER_URI", target, "glTF buffer uri must be a nonempty string");
          continue;
        }
        if (i === 0 && buffer.uri === undefined) {
          if (!seenBinary || buffer.byteLength > binaryLength || binaryLength - buffer.byteLength > 3) {
            error("GLTF_BUFFER_RANGE", target,
              "Embedded buffer byteLength must fit the BIN chunk with at most three padding bytes");
          }
        } else if (i > 0 && buffer.uri === undefined) {
          warn("GLTF_BUFFER_UNVERIFIED", target,
            "A later buffer without uri has no defined external or embedded location");
          cover("partial", "gltf-buffer", target, "Location of a non-first buffer is not defined by glTF 2.0");
        }
        if (typeof buffer.uri === "string") {
          if (/^data:/i.test(buffer.uri)) {
            cover("partial", "gltf-buffer-uri", target, "Inline data URI payload length and semantics are not checked");
          } else {
            const reference = await ctx.checkReference?.(buffer.uri, target,
              target + "#/buffers/" + i + "/uri");
            if (reference) {
              if ((await stat(reference)).size < buffer.byteLength) {
                error("GLTF_BUFFER_RANGE", target, "External buffer file is shorter than declared byteLength");
              }
              warn("GLTF_EXTERNAL_RESOURCE", target, "External glTF buffer contents are not inspected");
            }
            cover("skipped", "gltf-buffer", target, "External glTF buffer resource is not inspected");
          }
        }
      }
    }
    warn("GLTF_SEMANTICS_UNVERIFIED", target, "Use Khronos glTF Validator for full glTF semantic conformance");
    cover("checked", "glb-container", target, "GLB header, chunk layout, JSON, and embedded buffer bounds");
    cover("partial", "gltf-semantics", target, "glTF schema and semantic validation is not implemented");
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
  if (record.availableCount !== undefined &&
      (!Number.isSafeInteger(record.availableCount) || record.availableCount < 0)) {
    ctx.error("SUBTREE_AVAILABLE_COUNT", filePath, label + " availableCount must be a nonnegative safe integer");
  }
}

async function validateSubtreeJson(json, filePath, ctx, binaryLength, binaryFormat) {
  const { error, warn, cover } = ctx;
  if (!isRecord(json)) {
    error("SUBTREE_JSON", filePath, "Subtree JSON must be an object");
    return null;
  }
  if (json.bufferViews !== undefined && !Array.isArray(json.bufferViews)) {
    error("SUBTREE_BUFFER_VIEWS", filePath, "bufferViews must be an array when present");
  }
  if (json.buffers !== undefined && !Array.isArray(json.buffers)) {
    error("SUBTREE_BUFFERS", filePath, "buffers must be an array when present");
  }
  const views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    if (!isRecord(view) || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 ||
        (view.byteOffset !== undefined && !safeByteLength(view.byteOffset)) ||
        ((view.byteOffset ?? 0) % 8 !== 0) ||
        !Number.isSafeInteger(view.buffer) || view.buffer < 0 ||
        view.buffer >= buffers.length) {
      error("SUBTREE_BUFFER_VIEW", filePath, "Invalid bufferView at index " + i);
      continue;
    }
    const buffer = buffers[view.buffer];
    const offset = view.byteOffset ?? 0;
    if (!isRecord(buffer) || !safeByteLength(buffer.byteLength) ||
        offset > buffer.byteLength || view.byteLength > buffer.byteLength - offset) {
      error("SUBTREE_BUFFER_VIEW_RANGE", filePath, "bufferView exceeds declared buffer");
    }
  }
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    if (!isRecord(buffer) || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 1) {
      error("SUBTREE_BUFFER", filePath, "Invalid declared buffer at index " + i);
      continue;
    }
    if (buffer.uri !== undefined && (typeof buffer.uri !== "string" || buffer.uri.length === 0)) {
      error("SUBTREE_BUFFER_URI", filePath, "Buffer uri must be a nonempty string");
    } else if (typeof buffer.uri === "string") {
      if (/^data:/i.test(buffer.uri)) {
        error("SUBTREE_BUFFER_URI", filePath, "Data URIs are not supported for subtree buffers");
      } else {
        const reference = await ctx.checkReference?.(buffer.uri, filePath,
          filePath + "#/buffers/" + i + "/uri");
        if (reference && (await stat(reference)).size < buffer.byteLength) {
          error("SUBTREE_BUFFER_RANGE", filePath, "External buffer file is shorter than declared byteLength");
        }
        cover("skipped", "subtree-buffer", filePath, "External subtree buffer is not inspected");
      }
    } else if (i > 0) {
      error("SUBTREE_BUFFER_URI", filePath, "Only the first binary subtree buffer may omit uri");
    } else if (!binaryFormat) {
      error("SUBTREE_BUFFER_URI", filePath, "JSON subtree buffers must reference an external URI");
    } else if (buffer.byteLength > binaryLength || binaryLength - buffer.byteLength > 7) {
      error("SUBTREE_BUFFER_RANGE", filePath,
        "Embedded buffer must fit the binary chunk with at most seven padding bytes");
    }
  }
  validateAvailability(json.tileAvailability, "tileAvailability", ctx, filePath, views.length);
  if (json.contentAvailability !== undefined && !Array.isArray(json.contentAvailability)) {
    error("SUBTREE_CONTENT_AVAILABILITY", filePath, "contentAvailability must be an array when present");
  } else if (Array.isArray(json.contentAvailability)) {
    if (json.contentAvailability.length === 0) {
      error("SUBTREE_CONTENT_AVAILABILITY", filePath, "contentAvailability must be a nonempty array when present");
    }
    for (let i = 0; i < json.contentAvailability.length; i++) {
      validateAvailability(json.contentAvailability[i], "contentAvailability[" + i + "]", ctx, filePath, views.length);
    }
  }
  validateAvailability(json.childSubtreeAvailability, "childSubtreeAvailability", ctx, filePath, views.length);
  if (["tileMetadata", "contentMetadata", "subtreeMetadata", "propertyTables"]
    .some((key) => json[key] !== undefined)) {
    warn("SUBTREE_METADATA_UNVERIFIED", filePath, "Subtree metadata semantics are not checked");
    cover("skipped", "subtree-metadata", filePath, "Subtree metadata semantics are not checked");
  }
  warn("SUBTREE_SEMANTICS_UNVERIFIED", filePath,
    "Availability bit counts and cross-subtree semantics are not fully validated");
  cover("checked", binaryFormat ? "subtree-container" : "subtree-json",
    filePath, "Subtree fields, buffer declarations, and availability references");
  cover("partial", "subtree-semantics", filePath,
    "Availability bit counts and cross-subtree relationships are not fully validated");
  return {
    present: json.contentAvailability !== undefined,
    isArray: Array.isArray(json.contentAvailability),
    length: Array.isArray(json.contentAvailability) ? json.contentAvailability.length : undefined,
  };
}

export async function inspectSubtree(filePath, ctx) {
  const { error, options } = ctx;
  const size = (await stat(filePath)).size;
  if (size > options.maxFileBytes) {
    error("FILE_LIMIT", filePath, "File exceeds maxFileBytes");
    return;
  }
  const handle = await open(filePath, "r");
  try {
    const prefix = await readBytes(handle, 0, Math.min(size, 4));
    if (prefix.toString("ascii") !== "subt") {
      if (size > options.maxJsonBytes) {
        error("JSON_LIMIT", filePath, "JSON subtree exceeds maxJsonBytes");
        return;
      }
      let json;
      try {
        json = JSON.parse((await readBytes(handle, 0, size)).toString("utf8"));
      } catch {
        error("SUBTREE_JSON_PARSE", filePath, "Malformed JSON subtree");
        return;
      }
      return await validateSubtreeJson(json, filePath, ctx, 0, false);
    }
    if (size < 24) {
      error("SUBTREE_HEADER", filePath, "Binary subtree header is truncated");
      return;
    }
    const header = await readBytes(handle, 0, 24);
    if (header.readUInt32LE(4) !== 1) {
      error("SUBTREE_MAGIC_VERSION", filePath, "Expected binary subtree version 1");
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
    let json;
    try {
      json = JSON.parse((await readBytes(handle, 24, Number(jsonLength))).toString("utf8"));
    } catch {
      error("SUBTREE_JSON_PARSE", filePath, "Malformed subtree JSON");
      return;
    }
    return await validateSubtreeJson(json, filePath, ctx, Number(binLength), true);
  } finally {
    await handle.close();
  }
}
