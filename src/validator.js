import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { inspectGlb, inspectSubtree } from "./formats.js";

const DEFAULTS = Object.freeze({
  maxTiles: 100000,
  maxDepth: 128,
  maxJsonBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxResources: 100000,
  maxIssues: 500,
  checkContent: true,
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function nonnegative(value) {
  return finite(value) && value >= 0;
}
function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function volume(value, location, ctx) {
  if (!record(value)) {
    ctx.error("BOUNDING_VOLUME", location, "Expected boundingVolume object");
    return;
  }
  const keys = ["box", "region", "sphere"].filter((key) => value[key] !== undefined);
  if (keys.length !== 1) {
    ctx.error("BOUNDING_VOLUME", location, "Exactly one of box, region, or sphere is required");
    return;
  }
  const key = keys[0];
  const expected = key === "box" ? 12 : key === "region" ? 6 : 4;
  const entries = value[key];
  if (!Array.isArray(entries) || entries.length !== expected || !entries.every(finite)) {
    ctx.error("BOUNDING_VOLUME_VALUES", location, key + " must contain " + expected + " finite numbers");
    return;
  }
  if (key === "sphere" && entries[3] < 0) {
    ctx.error("BOUNDING_VOLUME_RADIUS", location, "Sphere radius cannot be negative");
  }
  if (key === "region") {
    const [west, south, east, north, minimum, maximum] = entries;
    if (Math.abs(west) > Math.PI || Math.abs(east) > Math.PI ||
        Math.abs(south) > Math.PI / 2 || Math.abs(north) > Math.PI / 2 ||
        south > north || minimum > maximum) {
      ctx.error("BOUNDING_VOLUME_REGION", location, "Invalid geographic region bounds");
    }
  }
}

function validateUriTemplate(uri, scheme, location, ctx) {
  if (typeof uri !== "string" || uri.length === 0) {
    ctx.error("IMPLICIT_URI", location, "Subtree URI template is required");
    return;
  }
  const tags = ["{level}", "{x}", "{y}"];
  if (scheme === "OCTREE") tags.push("{z}");
  if (tags.some((tag) => !uri.includes(tag))) {
    ctx.error("IMPLICIT_TEMPLATE", location, "Template must contain " + tags.join(", "));
  }
}

function makeContext(options) {
  const issues = [];
  const stats = { tilesets: 0, tiles: 0, resources: 0, glbs: 0, subtrees: 0 };
  const ctx = {
    options, issues, stats, stopped: false,
    error: (code, location, message) => append("ERROR", code, location, message),
    warn: (code, location, message) => append("WARNING", code, location, message),
  };
  function append(severity, code, location, message) {
    if (ctx.stopped) return;
    if (issues.length >= options.maxIssues - 1) {
      issues.push({ severity: "ERROR", code: "ISSUE_LIMIT", path: location,
        message: "Issue reporting limit reached" });
      ctx.stopped = true;
      return;
    }
    issues.push({ severity, code, path: location, message });
  }
  return ctx;
}

function validateOptions(input) {
  const options = { ...DEFAULTS, ...input };
  for (const key of ["maxTiles", "maxDepth", "maxJsonBytes", "maxFileBytes", "maxResources", "maxIssues"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) {
      throw new TypeError(key + " must be a positive safe integer");
    }
  }
  if (typeof options.checkContent !== "boolean") {
    throw new TypeError("checkContent must be boolean");
  }
  return options;
}

/**
 * Structural validation of a local 3D Tiles tileset. Does not replace
 * CesiumGS 3D Tiles Validator or Khronos glTF Validator conformance testing.
 *
 * @param {string} inputPath Path to tileset.json or a directory containing it
 * @param {object} [userOptions] Optional resource and traversal limits
 * @returns {Promise<{valid:boolean,issues:Array,stats:object,conformance:"partial"}>}
 */
export async function validateTileset(inputPath, userOptions = {}) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new TypeError("inputPath must be a nonempty string");
  }
  const options = validateOptions(userOptions);
  const ctx = makeContext(options);
  let entry = path.resolve(inputPath);
  try {
    if ((await stat(entry)).isDirectory()) entry = path.join(entry, "tileset.json");
  } catch (cause) {
    ctx.error("INPUT_IO", entry, "Could not access input: " + cause.code);
    return result(ctx);
  }
  let root;
  try {
    root = await realpath(path.dirname(entry));
  } catch {
    ctx.error("INPUT_IO", entry, "Could not resolve input directory");
    return result(ctx);
  }
  const scanned = new Set();
  const active = new Set();
  const resources = new Set();

  async function locate(raw, origin, location) {
    if (typeof raw !== "string" || raw.length === 0) {
      ctx.error("URI", location, "Resource URI must be a nonempty string");
      return null;
    }
    if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) {
      ctx.warn("REMOTE_UNVERIFIED", location, "External resources are not fetched");
      return null;
    }
    if (raw.includes("?") || raw.includes("#") || raw.includes("\\") ||
        /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      ctx.error("URI_UNSUPPORTED", location, "Unsupported URI scheme, query, fragment, or backslash");
      return null;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      ctx.error("URI_ENCODING", location, "Malformed URI encoding");
      return null;
    }
    if (decoded.includes("%") || decoded.includes("\\") || decoded.includes("\0") ||
        path.isAbsolute(decoded) || decoded.startsWith("//")) {
      ctx.error("URI_UNSAFE", location, "Unsafe or ambiguous relative resource URI");
      return null;
    }
    const absolute = path.resolve(path.dirname(origin), decoded);
    if (!within(root, absolute)) {
      ctx.error("URI_ESCAPE", location, "Resource escapes the tileset directory");
      return null;
    }
    try {
      const actual = await realpath(absolute);
      if (!within(root, actual)) {
        ctx.error("URI_SYMLINK_ESCAPE", location, "Resource symlink escapes tileset directory");
        return null;
      }
      const metadata = await stat(actual);
      if (!metadata.isFile()) {
        ctx.error("RESOURCE_NOT_FILE", location, "Resource is not a regular file");
        return null;
      }
      if (metadata.size > options.maxFileBytes) {
        ctx.error("FILE_LIMIT", location, "Resource exceeds maxFileBytes");
        return null;
      }
      return actual;
    } catch {
      ctx.error("RESOURCE_MISSING", location, "Referenced resource is missing or unreadable");
      return null;
    }
  }

  async function resource(uri, origin, location, kind = "content") {
    if (ctx.stopped || !options.checkContent) return;
    const target = await locate(uri, origin, location);
    if (!target) return;
    const suffix = path.extname(target).toLowerCase();
    if (suffix === ".json" && kind === "content") {
      await tileset(target);
      return;
    }
    if (resources.has(target)) return;
    if (resources.size >= options.maxResources) {
      ctx.error("RESOURCE_LIMIT", location, "Resource count limit reached");
      return;
    }
    resources.add(target);
    ctx.stats.resources++;
    try {
      if (suffix === ".glb") {
        ctx.stats.glbs++;
        await inspectGlb(target, ctx);
      } else if (suffix === ".subtree") {
        ctx.stats.subtrees++;
        await inspectSubtree(target, ctx);
      } else {
        ctx.warn("CONTENT_FORMAT_UNVERIFIED", location,
          "Referenced content exists but its format is not structurally checked: " + suffix);
      }
    } catch (cause) {
      ctx.error("RESOURCE_READ", location, "Could not inspect resource: " + (cause.code ?? cause.message));
    }
  }

  async function tile(node, location, depth, source) {
    if (ctx.stopped) return;
    if (depth > options.maxDepth || ctx.stats.tiles >= options.maxTiles) {
      ctx.error("TILE_LIMIT", location, "Tile depth or count limit reached");
      return;
    }
    ctx.stats.tiles++;
    if (!record(node)) {
      ctx.error("TILE", location, "Tile must be an object");
      return;
    }
    volume(node.boundingVolume, location + "/boundingVolume", ctx);
    if (!nonnegative(node.geometricError)) {
      ctx.error("GEOMETRIC_ERROR", location + "/geometricError", "Expected a finite nonnegative number");
    }
    if (node.refine !== undefined && node.refine !== "ADD" && node.refine !== "REPLACE") {
      ctx.error("REFINE", location + "/refine", "refine must be ADD or REPLACE");
    }
    if (node.transform !== undefined &&
        (!Array.isArray(node.transform) || node.transform.length !== 16 || !node.transform.every(finite))) {
      ctx.error("TRANSFORM", location + "/transform", "Expected 16 finite matrix values");
    }
    const implicit = node.implicitTiling ?? node.extensions?.["3DTILES_implicit_tiling"];
    if (implicit !== undefined) {
      if (!record(implicit)) {
        ctx.error("IMPLICIT", location, "implicitTiling must be an object");
      } else {
        const scheme = implicit.subdivisionScheme;
        if (scheme !== "QUADTREE" && scheme !== "OCTREE") {
          ctx.error("IMPLICIT_SCHEME", location, "Expected QUADTREE or OCTREE");
        }
        if (!Number.isSafeInteger(implicit.subtreeLevels) || implicit.subtreeLevels < 1 ||
            !Number.isSafeInteger(implicit.availableLevels) || implicit.availableLevels < 1) {
          ctx.error("IMPLICIT_LEVELS", location, "Invalid subtreeLevels or availableLevels");
        }
        const template = implicit.subtrees?.uri ?? implicit.subtrees?.url;
        validateUriTemplate(template, scheme, location + "/implicitTiling/subtrees", ctx);
        if (typeof template === "string" && (scheme === "QUADTREE" || scheme === "OCTREE")) {
          const rootSubtree = template
            .replaceAll("{level}", "0").replaceAll("{x}", "0")
            .replaceAll("{y}", "0").replaceAll("{z}", "0");
          await resource(rootSubtree, source, location + "/implicitTiling/rootSubtree", "subtree");
          ctx.warn("IMPLICIT_PARTIAL", location,
            "Only root subtree file is checked; deeper subtree availability is not traversed");
        }
      }
      if (node.children !== undefined) {
        ctx.error("IMPLICIT_CHILDREN", location, "Implicit root must not define explicit children");
      }
    }
    const contents = [];
    if (node.content !== undefined) contents.push(node.content);
    if (node.contents !== undefined) {
      if (!Array.isArray(node.contents)) ctx.error("CONTENTS", location, "contents must be an array");
      else contents.push(...node.contents);
    }
    for (let i = 0; i < contents.length; i++) {
      const content = contents[i];
      if (!record(content)) {
        ctx.error("CONTENT", location + "/contents/" + i, "Content must be an object");
        continue;
      }
      if (content.boundingVolume !== undefined) {
        volume(content.boundingVolume, location + "/contents/" + i + "/boundingVolume", ctx);
      }
      const uri = content.uri ?? content.url;
      if (typeof uri !== "string" || uri.length === 0) {
        ctx.error("CONTENT_URI", location + "/contents/" + i, "Content uri/url is required");
      } else if (implicit !== undefined) {
        ctx.warn("IMPLICIT_CONTENT_UNVERIFIED", location + "/contents/" + i,
          "Implicit content URI template instances are not traversed");
      } else {
        await resource(uri, source, location + "/contents/" + i);
      }
    }
    if (node.children !== undefined && implicit === undefined) {
      if (!Array.isArray(node.children)) {
        ctx.error("CHILDREN", location + "/children", "children must be an array");
      } else {
        for (let i = 0; i < node.children.length; i++) {
          await tile(node.children[i], location + "/children/" + i, depth + 1, source);
          if (ctx.stopped) return;
        }
      }
    }
  }

  async function tileset(file) {
    if (active.has(file)) {
      ctx.error("TILESET_CYCLE", file, "Cyclic external tileset reference");
      return;
    }
    if (scanned.has(file) || ctx.stopped) return;
    scanned.add(file);
    active.add(file);
    try {
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size > options.maxJsonBytes) {
        ctx.error("JSON_LIMIT", file, "Tileset JSON missing or exceeds maxJsonBytes");
        return;
      }
      let json;
      try {
        json = JSON.parse(await readFile(file, "utf8"));
      } catch {
        ctx.error("JSON_PARSE", file, "Could not parse tileset JSON");
        return;
      }
      ctx.stats.tilesets++;
      if (!record(json) || !record(json.asset) ||
          !["1.0", "1.1"].includes(json.asset.version)) {
        ctx.error("TILESET_ASSET", file, "Expected asset.version 1.0 or 1.1");
      }
      if (!record(json)) return;
      if (!nonnegative(json.geometricError)) {
        ctx.error("TILESET_GEOMETRIC_ERROR", file, "Expected finite nonnegative geometricError");
      }
      if (json.root === undefined) {
        ctx.error("TILESET_ROOT", file, "Missing root tile");
      } else {
        await tile(json.root, file + "#/root", 0, file);
      }
    } catch (cause) {
      ctx.error("TILESET_IO", file, "Could not read tileset: " + (cause.code ?? cause.message));
    } finally {
      active.delete(file);
    }
  }

  try {
    const actual = await realpath(entry);
    if (!within(root, actual)) {
      ctx.error("INPUT_ESCAPE", entry, "Tileset path escapes its root directory");
    } else {
      await tileset(actual);
    }
  } catch {
    ctx.error("INPUT_IO", entry, "Tileset file cannot be opened");
  }
  if (!options.checkContent) {
    ctx.warn("CONTENT_SKIPPED", entry, "Content checking was disabled");
  }
  return result(ctx);
}

function result(ctx) {
  return {
    valid: !ctx.issues.some((issue) => issue.severity === "ERROR"),
    conformance: "partial",
    issues: ctx.issues,
    stats: ctx.stats,
  };
}

export { DEFAULTS as validationLimits };
