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

function availability(value, label, filePath, ctx, viewCount) {
  if (!isRecord(value)) {
    ctx.error("SUBTREE_AVAILABILITY", filePath + "#/" + label, label + " must be an object");
    return null;
  }
  const hasConstant = value.constant !== undefined;
  const hasBitstream = value.bitstream !== undefined;
  if (hasConstant === hasBitstream) {
    ctx.error("SUBTREE_AVAILABILITY", filePath + "#/" + label,
      label + " must define exactly one of constant or bitstream");
    return null;
  }
  let result;
  if (hasConstant) {
    if (value.constant !== 0 && value.constant !== 1) {
      ctx.error("SUBTREE_CONSTANT", filePath + "#/" + label, label + " constant must be 0 or 1");
      return null;
    }
    result = { constant: value.constant };
  } else {
    if (!Number.isSafeInteger(value.bitstream) || value.bitstream < 0 || value.bitstream >= viewCount) {
      ctx.error("SUBTREE_BITSTREAM", filePath + "#/" + label,
        label + " references an invalid bufferView");
      return null;
    }
    result = { viewIndex: value.bitstream };
  }
  if (value.availableCount !== undefined) {
    if (!Number.isSafeInteger(value.availableCount) || value.availableCount < 0) {
      ctx.error("SUBTREE_AVAILABLE_COUNT", filePath + "#/" + label,
        label + " availableCount must be a nonnegative safe integer");
    } else {
      result.availableCount = BigInt(value.availableCount);
    }
  }
  return result;
}

function popcount(byte) {
  byte -= (byte >>> 1) & 0x55;
  byte = (byte & 0x33) + ((byte >>> 2) & 0x33);
  return (byte + (byte >>> 4)) & 0x0f;
}

async function makeBufferSources(json, filePath, ctx, binaryStart, binaryLength, binaryFormat) {
  const { error, cover } = ctx;
  if (json.bufferViews !== undefined && !Array.isArray(json.bufferViews)) {
    error("SUBTREE_BUFFER_VIEWS", filePath, "bufferViews must be an array when present");
  }
  if (json.buffers !== undefined && !Array.isArray(json.buffers)) {
    error("SUBTREE_BUFFERS", filePath, "buffers must be an array when present");
  }
  const views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const sources = [];
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    if (!isRecord(buffer) || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 1) {
      error("SUBTREE_BUFFER", filePath, "Invalid declared buffer at index " + i);
      sources.push(null);
      continue;
    }
    if (buffer.uri !== undefined && (typeof buffer.uri !== "string" || buffer.uri.length === 0)) {
      error("SUBTREE_BUFFER_URI", filePath, "Buffer uri must be a nonempty string");
      sources.push(null);
    } else if (typeof buffer.uri === "string") {
      if (/^data:/i.test(buffer.uri)) {
        error("SUBTREE_BUFFER_URI", filePath, "Data URIs are not supported for subtree buffers");
        sources.push(null);
      } else {
        const target = await ctx.checkReference?.(buffer.uri, filePath,
          filePath + "#/buffers/" + i + "/uri");
        if (!target) {
          sources.push(null);
        } else if ((await stat(target)).size < buffer.byteLength) {
          error("SUBTREE_BUFFER_RANGE", filePath,
            "External buffer file is shorter than declared byteLength");
          sources.push(null);
        } else {
          sources.push({ filePath: target, baseOffset: 0, byteLength: buffer.byteLength });
          cover("checked", "subtree-buffer", filePath,
            "External subtree buffer reference and declared byteLength");
        }
      }
    } else if (i > 0) {
      error("SUBTREE_BUFFER_URI", filePath, "Only the first binary subtree buffer may omit uri");
      sources.push(null);
    } else if (!binaryFormat) {
      error("SUBTREE_BUFFER_URI", filePath, "JSON subtree buffers must reference an external URI");
      sources.push(null);
    } else if (buffer.byteLength > binaryLength || binaryLength - buffer.byteLength > 7) {
      error("SUBTREE_BUFFER_RANGE", filePath,
        "Embedded buffer must fit the binary chunk with at most seven padding bytes");
      sources.push(null);
    } else {
      sources.push({ filePath, baseOffset: binaryStart, byteLength: buffer.byteLength });
    }
  }
  const viewSources = [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    if (!isRecord(view) || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 ||
        (view.byteOffset !== undefined && !safeByteLength(view.byteOffset)) ||
        ((view.byteOffset ?? 0) % 8 !== 0) ||
        !Number.isSafeInteger(view.buffer) || view.buffer < 0 || view.buffer >= buffers.length) {
      error("SUBTREE_BUFFER_VIEW", filePath, "Invalid bufferView at index " + i);
      viewSources.push(null);
      continue;
    }
    const buffer = buffers[view.buffer];
    const source = sources[view.buffer];
    const offset = view.byteOffset ?? 0;
    if (!isRecord(buffer) || !safeByteLength(buffer.byteLength) ||
        offset > buffer.byteLength || view.byteLength > buffer.byteLength - offset) {
      error("SUBTREE_BUFFER_VIEW_RANGE", filePath, "bufferView exceeds declared buffer");
      viewSources.push(null);
    } else {
      viewSources.push(source ? {
        filePath: source.filePath,
        baseOffset: source.baseOffset + offset,
        byteLength: view.byteLength,
      } : null);
    }
  }
  return { views, viewSources };
}

function expectedBits(branching, subtreeLevels, maxFileBytes) {
  const n = BigInt(branching);
  const maxBits = BigInt(maxFileBytes) * 8n < BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(maxFileBytes) * 8n : BigInt(Number.MAX_SAFE_INTEGER);
  let layer = 1n;
  let tileBits = 0n;
  for (let level = 0; level < subtreeLevels; level++) {
    tileBits += layer;
    if (tileBits > maxBits) return null;
    layer *= n;
  }
  if (layer > maxBits) return null;
  return { tileBits, childBits: layer };
}

async function makeBitReader(viewSources) {
  const handles = new Map();
  async function read(source, offset, length) {
    let handle = handles.get(source.filePath);
    if (!handle) {
      handle = await open(source.filePath, "r");
      handles.set(source.filePath, handle);
    }
    return readBytes(handle, source.baseOffset + offset, length);
  }
  async function readRange(descriptor, startBit, bitCount) {
    if (!descriptor || bitCount <= 0) return Buffer.alloc(0);
    const byteLength = Math.ceil(bitCount / 8);
    if (descriptor.constant !== undefined) {
      return Buffer.alloc(byteLength, descriptor.constant ? 0xff : 0);
    }
    const source = viewSources[descriptor.viewIndex];
    if (!source) return Buffer.alloc(byteLength);
    const firstByte = Math.floor(startBit / 8);
    const shift = startBit & 7;
    const rawLength = Math.ceil((shift + bitCount) / 8);
    const raw = await read(source, firstByte, rawLength);
    if (shift === 0) return raw.subarray(0, byteLength);
    const normalized = Buffer.alloc(byteLength);
    for (let i = 0; i < byteLength; i++) {
      normalized[i] = (raw[i] >>> shift) | ((raw[i + 1] ?? 0) << (8 - shift));
    }
    return normalized;
  }
  return {
    readRange,
    async close() {
      await Promise.all([...handles.values()].map((handle) => handle.close()));
    },
  };
}

async function validateBitstream(descriptor, label, bitCount, filePath, reader, views, viewSources, ctx) {
  if (descriptor.constant !== undefined) {
    const count = descriptor.constant ? bitCount : 0n;
    if (descriptor.availableCount !== undefined && descriptor.availableCount !== count) {
      ctx.error("SUBTREE_AVAILABLE_COUNT", filePath + "#/" + label,
        label + " availableCount does not match the number of available elements");
    }
    return count;
  }
  const view = views[descriptor.viewIndex];
  const source = viewSources[descriptor.viewIndex];
  const expectedLength = (bitCount + 7n) / 8n;
  if (!view || !source || expectedLength > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(view.byteLength) !== expectedLength) {
    ctx.error("SUBTREE_BITSTREAM_LENGTH", filePath + "#/" + label,
      label + " bufferView byteLength must equal ceil(expected availability bits / 8)");
    return null;
  }
  if (descriptor.availableCount === undefined) {
    const remainder = Number(bitCount & 7n);
    if (remainder > 0) {
      const last = await reader.readRange(descriptor, Number(bitCount - BigInt(remainder)), remainder);
      const mask = (1 << remainder) - 1;
      if ((last[0] & ~mask) !== 0) {
        ctx.error("SUBTREE_BITSTREAM_PADDING", filePath + "#/" + label,
          label + " trailing padding bits must be zero");
      }
    }
    return -1n;
  }
  let count = 0n;
  const chunkBytes = 64 * 1024;
  const byteLength = Number(expectedLength);
  for (let offset = 0; offset < byteLength; offset += chunkBytes) {
    const bits = Math.min((byteLength - offset) * 8, chunkBytes * 8, Number(bitCount - BigInt(offset) * 8n));
    const bytes = await reader.readRange(descriptor, offset * 8, bits);
    const wholeBytes = Math.floor(bits / 8);
    for (let i = 0; i < wholeBytes; i++) count += BigInt(popcount(bytes[i]));
    const remainder = bits & 7;
    if (remainder > 0) {
      const mask = (1 << remainder) - 1;
      count += BigInt(popcount(bytes[wholeBytes] & mask));
      if ((bytes[wholeBytes] & ~mask) !== 0) {
        ctx.error("SUBTREE_BITSTREAM_PADDING", filePath + "#/" + label,
          label + " trailing padding bits must be zero");
      }
    }
  }
  if (descriptor.availableCount !== undefined && descriptor.availableCount !== count) {
    ctx.error("SUBTREE_AVAILABLE_COUNT", filePath + "#/" + label,
      label + " availableCount does not match the number of available elements");
  }
  return count;
}

function setBit(bytes, index) {
  return (bytes[index >> 3] & (1 << (index & 7))) !== 0;
}

async function forEachSetBit(bytes, bitCount, callback) {
  const byteCount = Math.ceil(bitCount / 8);
  for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
    let mask = bytes[byteIndex] ?? 0;
    if (byteIndex === byteCount - 1 && (bitCount & 7) !== 0) {
      mask &= (1 << (bitCount & 7)) - 1;
    }
    while (mask !== 0) {
      const lowest = mask & -mask;
      const bitIndex = 31 - Math.clz32(lowest);
      if (await callback(byteIndex * 8 + bitIndex) === false) return false;
      mask &= mask - 1;
    }
  }
  return true;
}

async function validateAvailabilityRelations({
  filePath, ctx, reader, tile, contents, child, tileBits, childBits, branching,
  subtreeLevels, rootLevel, availableLevels, baseDepth, maxDepth, onContent, onChild,
  onWork,
}) {
  const branchBig = BigInt(branching);
  const chunkBitsMax = 64 * 1024 * 8;
  let levelOffset = 0n;
  let levelSize = 1n;
  let issueTileParent = false;
  let issueContentTile = false;
  let issueUnavailableLevel = false;
  let issueDepth = false;
  let stopContentCallbacks = false;
  for (let level = 0; level < subtreeLevels; level++) {
    const levelBig = BigInt(level);
    for (let start = 0n; start < levelSize; start += BigInt(chunkBitsMax)) {
      const count = Number(levelSize - start > BigInt(chunkBitsMax) ? BigInt(chunkBitsMax) : levelSize - start);
      const tileBytes = tile.constant === undefined
        ? await reader.readRange(tile, Number(levelOffset + start), count) : null;
      const parentStart = start / branchBig;
      const parentCount = level === 0 ? 0 : Math.ceil(count / branching);
      const parentBytes = level === 0 || tile.constant !== undefined ? null : await reader.readRange(
        tile, Number(levelOffset - (levelSize / branchBig) + parentStart), parentCount);
      const contentBytes = [];
      for (const content of contents) {
        contentBytes.push(await reader.readRange(content, Number(levelOffset + start), count));
      }
      const globalLevel = rootLevel + levelBig;
      const depthExceeded = baseDepth + globalLevel > BigInt(maxDepth);
      const levelUnavailable = globalLevel >= BigInt(availableLevels);
      if (tile.constant === 1) {
        if (levelUnavailable && !issueUnavailableLevel) {
          ctx.error("SUBTREE_LEVEL_AVAILABILITY", filePath + "#/tileAvailability",
            "Tiles at or beyond availableLevels must be unavailable");
          issueUnavailableLevel = true;
        }
        if (depthExceeded && !issueDepth) {
          ctx.error("TILE_LIMIT", filePath + "#/tileAvailability",
            "Implicit tile depth limit reached");
          issueDepth = true;
        }
      } else if (tileBytes) {
        const completed = await forEachSetBit(tileBytes, count, async (i) => {
          if (onWork && await onWork() === false) return false;
          if (levelUnavailable && !issueUnavailableLevel) {
            ctx.error("SUBTREE_LEVEL_AVAILABILITY", filePath + "#/tileAvailability",
              "Tiles at or beyond availableLevels must be unavailable");
            issueUnavailableLevel = true;
          }
          if (depthExceeded && !issueDepth) {
            ctx.error("TILE_LIMIT", filePath + "#/tileAvailability",
              "Implicit tile depth limit reached");
            issueDepth = true;
          }
          if (level > 0 && !setBit(parentBytes, Math.floor(i / branching)) && !issueTileParent) {
            ctx.error("SUBTREE_TILE_PARENT_UNAVAILABLE", filePath + "#/tileAvailability",
              "An available tile has an unavailable parent");
            issueTileParent = true;
          }
          return true;
        });
        if (!completed) return;
      }
      for (let contentIndex = 0; contentIndex < contentBytes.length; contentIndex++) {
        if (!contents[contentIndex] || contents[contentIndex].constant === 0 ||
            (tile.constant === 1 && !onContent)) continue;
        const completed = await forEachSetBit(contentBytes[contentIndex], count, async (i) => {
          if (onWork && await onWork() === false) return false;
          const tileAvailable = tile.constant === 1 ||
            (tile.constant === undefined && setBit(tileBytes, i));
          if (!tileAvailable) {
            if (!issueContentTile) {
              ctx.error("SUBTREE_CONTENT_TILE_UNAVAILABLE", filePath + "#/contentAvailability/" + contentIndex,
                "Available content must belong to an available tile");
              issueContentTile = true;
            }
            return true;
          }
          const parentAvailable = tile.constant === 1 || level === 0 ||
            setBit(parentBytes, Math.floor(i / branching));
          if (level > 0 && !parentAvailable && !issueTileParent) {
            ctx.error("SUBTREE_TILE_PARENT_UNAVAILABLE", filePath + "#/tileAvailability",
              "An available tile has an unavailable parent");
            issueTileParent = true;
          }
          if (!parentAvailable || levelUnavailable || depthExceeded) return true;
          if (!stopContentCallbacks && onContent &&
              await onContent(contentIndex, Number(levelBig), start + BigInt(i)) === false) {
            stopContentCallbacks = true;
          }
          return true;
        });
        if (!completed) return;
      }
    }
    levelOffset += levelSize;
    levelSize *= branchBig;
  }
  const lastTileOffset = tileBits - levelSize / branchBig;
  let issueChildParent = false;
  const childLevel = rootLevel + BigInt(subtreeLevels);
  const childLevelUnavailable = childLevel >= BigInt(availableLevels);
  let stopChildCallbacks = false;
  for (let start = 0n; start < childBits; start += BigInt(chunkBitsMax)) {
    const count = Number(childBits - start > BigInt(chunkBitsMax) ? BigInt(chunkBitsMax) : childBits - start);
    if (child.constant === 0) break;
    const childBytes = await reader.readRange(child, Number(start), count);
    const parentStart = start / branchBig;
    const parentCount = Math.ceil(count / branching);
    const parentBytes = tile.constant === 1 ? null : await reader.readRange(tile,
      Number(lastTileOffset + parentStart), parentCount);
    const completed = await forEachSetBit(childBytes, count, async (i) => {
      if (onWork && await onWork() === false) return false;
      if (childLevelUnavailable) {
        if (!issueUnavailableLevel) {
          ctx.error("SUBTREE_LEVEL_AVAILABILITY", filePath + "#/childSubtreeAvailability",
            "Child subtrees at or beyond availableLevels must be unavailable");
          issueUnavailableLevel = true;
        }
        return true;
      }
      if (baseDepth + childLevel > BigInt(maxDepth)) {
        if (!issueDepth) {
          ctx.error("TILE_LIMIT", filePath + "#/childSubtreeAvailability",
            "Implicit subtree depth limit reached");
          issueDepth = true;
        }
        return true;
      }
      const parentAvailable = tile.constant === 1 ||
        (tile.constant === undefined && setBit(parentBytes, Math.floor(i / branching)));
      if (!parentAvailable) {
        if (!issueChildParent) {
          ctx.error("SUBTREE_CHILD_PARENT_UNAVAILABLE", filePath + "#/childSubtreeAvailability",
            "An available child subtree must have an available parent tile");
          issueChildParent = true;
        }
        return true;
      }
      if (!stopChildCallbacks && onChild && await onChild(start + BigInt(i)) === false) {
        stopChildCallbacks = true;
      }
      return true;
    });
    if (!completed) return;
  }
}

async function validateSubtreeJson(json, filePath, ctx, options) {
  const { error, warn, cover } = ctx;
  if (!isRecord(json)) {
    error("SUBTREE_JSON", filePath, "Subtree JSON must be an object");
    return null;
  }
  const { binaryLength, binaryStart, binaryFormat, scheme, subtreeLevels, availableLevels,
    rootLevel = 0, baseDepth = 0, maxDepth, expectedContentCount, onContent, onChild, onWork } = options;
  const branching = scheme === "OCTREE" ? 8 : 4;
  const lengths = expectedBits(branching, subtreeLevels, ctx.options.maxFileBytes);
  if (!lengths) {
    error("SUBTREE_AVAILABILITY_LIMIT", filePath,
      "Expected availability bitstreams exceed maxFileBytes or safe traversal bounds");
    return null;
  }
  const { views, viewSources } = await makeBufferSources(
    json, filePath, ctx, binaryStart, binaryLength, binaryFormat);
  const tile = availability(json.tileAvailability, "tileAvailability", filePath, ctx, views.length);
  const child = availability(json.childSubtreeAvailability,
    "childSubtreeAvailability", filePath, ctx, views.length);
  let content = [];
  if (json.contentAvailability !== undefined && !Array.isArray(json.contentAvailability)) {
    error("SUBTREE_CONTENT_AVAILABILITY", filePath,
      "contentAvailability must be an array when present");
  } else if (Array.isArray(json.contentAvailability)) {
    if (json.contentAvailability.length === 0) {
      error("SUBTREE_CONTENT_AVAILABILITY", filePath,
        "contentAvailability must be a nonempty array when present");
    }
    content = json.contentAvailability.map((entry, i) =>
      availability(entry, "contentAvailability/" + i, filePath, ctx, views.length));
  }
  if (expectedContentCount !== undefined) {
    if (expectedContentCount > 0 && json.contentAvailability === undefined) {
      error("SUBTREE_CONTENT_AVAILABILITY_MISSING", filePath,
        "Subtree must define contentAvailability for each declared implicit content");
    } else if (expectedContentCount === 0 && json.contentAvailability !== undefined) {
      error("SUBTREE_CONTENT_AVAILABILITY_UNEXPECTED", filePath,
        "contentAvailability must be omitted when the implicit root has no content templates");
    } else if (Array.isArray(json.contentAvailability) &&
        json.contentAvailability.length !== expectedContentCount) {
      error("SUBTREE_CONTENT_AVAILABILITY_COUNT", filePath,
        "contentAvailability entries must match the implicit root content count");
    }
  }
  if (["tileMetadata", "contentMetadata", "subtreeMetadata", "propertyTables"]
    .some((key) => json[key] !== undefined)) {
    warn("SUBTREE_METADATA_UNVERIFIED", filePath, "Subtree metadata semantics are not checked");
    cover("skipped", "subtree-metadata", filePath, "Subtree metadata semantics are not checked");
  }
  if (json.extensions !== undefined || json.extensionsUsed !== undefined ||
      json.extensionsRequired !== undefined) {
    warn("SUBTREE_EXTENSION_UNVERIFIED", filePath,
      "Subtree extension semantics are not checked");
    cover("skipped", "subtree-extension", filePath,
      "No subtree extension semantics are implemented");
  }
  const descriptors = [tile, ...content, child];
  const counts = [lengths.tileBits, ...content.map(() => lengths.tileBits), lengths.childBits];
  const names = ["tileAvailability", ...content.map((_, i) => "contentAvailability/" + i),
    "childSubtreeAvailability"];
  const reader = await makeBitReader(viewSources);
  try {
    let tileCount = null;
    for (let i = 0; i < descriptors.length; i++) {
      if (!descriptors[i]) continue;
      const count = await validateBitstream(descriptors[i], names[i], counts[i],
        filePath, reader, views, viewSources, ctx);
      if (i === 0) tileCount = count;
    }
    if (tileCount === 0n) {
      error("SUBTREE_TILE_EMPTY", filePath + "#/tileAvailability",
        "A subtree must contain at least one available tile");
    }
    if (tile && child && tileCount !== null) {
      const rootBits = await reader.readRange(tile, 0, 1);
      if (!setBit(rootBits, 0)) {
        error("SUBTREE_ROOT_UNAVAILABLE", filePath + "#/tileAvailability",
          "The root tile of a subtree must be available");
      }
      await validateAvailabilityRelations({
        filePath, ctx, reader, tile, contents: content, child,
        tileBits: lengths.tileBits, childBits: lengths.childBits, branching,
        subtreeLevels, rootLevel: BigInt(rootLevel), availableLevels,
        baseDepth: BigInt(baseDepth), maxDepth, onContent, onChild, onWork,
      });
    }
  } finally {
    await reader.close();
  }
  cover("checked", binaryFormat ? "subtree-container" : "subtree-json",
    filePath, "Subtree JSON fields, chunk layout, buffer declarations, and availability references");
  cover("checked", "subtree-availability", filePath,
    "Availability lengths, padding, counts, and tile/content/subtree relationships");
  return {
    present: json.contentAvailability !== undefined,
    isArray: Array.isArray(json.contentAvailability),
    length: Array.isArray(json.contentAvailability) ? json.contentAvailability.length : undefined,
  };
}

export async function inspectSubtree(filePath, ctx, options = {}) {
  const { error, options: limits } = ctx;
  const size = (await stat(filePath)).size;
  if (size > limits.maxFileBytes) {
    error("FILE_LIMIT", filePath, "File exceeds maxFileBytes");
    return null;
  }
  const handle = await open(filePath, "r");
  try {
    const prefix = await readBytes(handle, 0, Math.min(size, 4));
    if (prefix.toString("ascii") !== "subt") {
      if (size > limits.maxJsonBytes) {
        error("JSON_LIMIT", filePath, "JSON subtree exceeds maxJsonBytes");
        return null;
      }
      let json;
      try {
        json = JSON.parse((await readBytes(handle, 0, size)).toString("utf8"));
      } catch {
        error("SUBTREE_JSON_PARSE", filePath, "Malformed JSON subtree");
        return null;
      }
      return await validateSubtreeJson(json, filePath, ctx, {
        ...options, binaryLength: 0, binaryStart: 0, binaryFormat: false,
      });
    }
    if (size < 24) {
      error("SUBTREE_HEADER", filePath, "Binary subtree header is truncated");
      return null;
    }
    const header = await readBytes(handle, 0, 24);
    if (header.readUInt32LE(4) !== 1) {
      error("SUBTREE_MAGIC_VERSION", filePath, "Expected binary subtree version 1");
      return null;
    }
    const jsonLength = header.readBigUInt64LE(8);
    const binLength = header.readBigUInt64LE(16);
    if (jsonLength > BigInt(limits.maxJsonBytes) || jsonLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      error("JSON_LIMIT", filePath, "Subtree JSON exceeds maxJsonBytes or safe integer range");
      return null;
    }
    if (binLength > BigInt(Number.MAX_SAFE_INTEGER) ||
        24n + jsonLength + binLength !== BigInt(size)) {
      error("SUBTREE_LENGTH", filePath, "Subtree chunk lengths do not match file size");
      return null;
    }
    if (jsonLength % 8n !== 0n || binLength % 8n !== 0n) {
      error("SUBTREE_ALIGNMENT", filePath, "Subtree chunk lengths must be 8-byte aligned");
      return null;
    }
    let json;
    try {
      json = JSON.parse((await readBytes(handle, 24, Number(jsonLength))).toString("utf8"));
    } catch {
      error("SUBTREE_JSON_PARSE", filePath, "Malformed subtree JSON");
      return null;
    }
    return await validateSubtreeJson(json, filePath, ctx, {
      ...options, binaryLength: Number(binLength), binaryStart: 24 + Number(jsonLength), binaryFormat: true,
    });
  } finally {
    await handle.close();
  }
}
