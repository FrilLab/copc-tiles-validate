import path from "node:path";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { inspectGlb, inspectSubtree } from "./formats.js";

const DEFAULTS = Object.freeze({
  maxTiles: 100000,
  maxDepth: 128,
  maxJsonBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxResources: 100000,
  maxIssues: 500,
  checkContent: true,
  failOnUnverified: false,
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

async function sniffResource(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);
    const text = prefix.toString("utf8");
    const first = text.search(/\S/);
    return {
      magic: prefix.toString("ascii", 0, Math.min(4, bytesRead)),
      tilesetLike: first >= 0 && text[first] === "{" &&
        ['"asset"', '"root"', '"geometricError"'].every((key) => text.includes(key)),
    };
  } finally {
    await handle.close();
  }
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
  const found = [...uri.matchAll(/\{([^{}]*)\}/g)];
  const allowed = new Set(tags);
  if (/[{}]/.test(uri.replace(/\{[^{}]*\}/g, "")) ||
      found.some((match) => !allowed.has("{" + match[1] + "}"))) {
    ctx.error("IMPLICIT_TEMPLATE", location, "Template contains malformed or unsupported placeholders");
  }
}

function makeContext(options) {
  const issues = [];
  const stats = { tilesets: 0, tiles: 0, resources: 0, glbs: 0, subtrees: 0 };
  const coverage = new Map();
  const ctx = {
    options, issues, stats, stopped: false,
    error: (code, location, message) => append("ERROR", code, location, message),
    warn: (code, location, message) => append("WARNING", code, location, message),
    cover: (status, kind, location, reason) => {
      const key = [status, kind, reason ?? ""].join("\u0000");
      let entry = coverage.get(key);
      if (!entry) {
        entry = { status, kind, count: 0, ...(reason ? { reason } : {}), paths: [] };
        coverage.set(key, entry);
      }
      entry.count++;
      if (entry.paths.length < 5 && !entry.paths.includes(location)) entry.paths.push(location);
    },
    coverageReport: () => {
      const entries = [...coverage.values()];
      const checked = entries.filter((entry) => entry.status === "checked");
      const partial = entries.filter((entry) => entry.status === "partial");
      const skipped = entries.filter((entry) => entry.status === "skipped");
      const status = skipped.length > 0 ? "incomplete" : partial.length > 0 ? "partial" : "complete";
      return { status, checked, partial, skipped };
    },
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
  if (typeof options.failOnUnverified !== "boolean") {
    throw new TypeError("failOnUnverified must be boolean");
  }
  return options;
}

/**
 * Structural validation of a local 3D Tiles tileset. Does not replace
 * CesiumGS 3D Tiles Validator or Khronos glTF Validator conformance testing.
 *
 * @param {string} inputPath Path to tileset.json or a directory containing it
 * @param {object} [userOptions] Optional resource and traversal limits
 * @returns {Promise<{valid:boolean,passed:boolean,issues:Array,stats:object,coverage:object,conformance:"partial"}>}
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
  if (/\.(3tz|3dtiles)$/i.test(entry)) {
    ctx.error("PACKAGE_UNSUPPORTED", entry, "3TZ and .3dtiles archives are not supported yet");
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
  const inspectedResources = new Set();
  let contentCheckSkipped = false;

  async function locate(raw, origin, location) {
    if (typeof raw !== "string" || raw.length === 0) {
      ctx.error("URI", location, "Resource URI must be a nonempty string");
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
      ctx.warn("EXTERNAL_UNVERIFIED", location, "External URI resources are not fetched");
      ctx.cover("skipped", "resource", location, "External URI resource is not fetched");
      return null;
    }
    if (raw.startsWith("/")) {
      ctx.warn("EXTERNAL_UNVERIFIED", location, "Absolute URI paths are not resolved against the local input root");
      ctx.cover("skipped", "resource", location, "Absolute URI path is outside local relative-resource checking");
      return null;
    }
    if (raw.includes("?") || raw.includes("#")) {
      ctx.warn("URI_REFERENCE_UNVERIFIED", location, "Query and fragment URI references are not resolved locally");
      ctx.cover("skipped", "resource", location, "Query or fragment prevents local resource resolution");
      return null;
    }
    if (raw.includes("\\")) {
      ctx.error("URI_BACKSLASH", location, "Resource URI must use forward slashes");
      ctx.cover("skipped", "resource", location, "Unsupported URI syntax or scheme");
      return null;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      ctx.error("URI_ENCODING", location, "Malformed URI encoding");
      return null;
    }
    if (decoded.includes("\\") || decoded.includes("\0") ||
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

  ctx.checkReference = async (raw, origin, location) => {
    const target = await locate(raw, origin, location);
    if (!target) return null;
    if (!resources.has(target)) {
      if (resources.size >= options.maxResources) {
        ctx.error("RESOURCE_LIMIT", location, "Resource count limit reached");
        return null;
      }
      resources.add(target);
      ctx.stats.resources++;
    }
    ctx.cover("checked", "local-resource-reference", location,
      "Relative resource URI resolves to a regular file inside the input root");
    return target;
  };

  async function resource(uri, origin, location, kind = "content", formatOptions = {}) {
    if (ctx.stopped) return;
    if (!options.checkContent) {
      contentCheckSkipped = true;
      return;
    }
    const target = await locate(uri, origin, location);
    if (!target) return;
    const suffix = path.extname(target).toLowerCase();
    if (kind === "content" && active.has(target)) {
      await tileset(target);
      return;
    }
    if (kind === "content" && scanned.has(target)) return;
    if (inspectedResources.has(target)) return;
    if (!resources.has(target)) {
      if (resources.size >= options.maxResources) {
        ctx.error("RESOURCE_LIMIT", location, "Resource count limit reached");
        return;
      }
      resources.add(target);
      ctx.stats.resources++;
    }
    const sniffed = suffix === ".glb" || suffix === ".subtree" ? null : await sniffResource(target);
    const externalTileset = kind === "content" &&
      ((suffix === ".json" && sniffed?.magic !== "glTF") ||
       (suffix !== ".gltf" && sniffed?.tilesetLike));
    if (externalTileset) {
      await tileset(target);
      return;
    }
    inspectedResources.add(target);
    try {
      if (kind === "subtree" || suffix === ".subtree") {
        ctx.stats.subtrees++;
        await inspectSubtree(target, ctx, formatOptions.expectedContentCount);
      } else if (suffix === ".glb" || sniffed?.magic === "glTF") {
        ctx.stats.glbs++;
        await inspectGlb(target, ctx);
      } else {
        ctx.warn("CONTENT_FORMAT_UNVERIFIED", location,
          "Referenced content exists, but its format is not identified or structurally checked");
        ctx.cover("skipped", "content-format", location,
          "No structural checker matched the resource format");
      }
    } catch (cause) {
      ctx.error("RESOURCE_READ", location, "Could not inspect resource: " + (cause.code ?? cause.message));
    }
  }

  async function tile(node, location, depth, source, version, extensionsUsed, groupCount) {
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
    ctx.cover("checked", "tile-structure", location, "Tile object fields and local tree structure");
    if (node.metadata !== undefined) {
      ctx.warn("TILE_METADATA_UNVERIFIED", location, "Tile metadata semantics are not checked");
      ctx.cover("skipped", "tile-metadata", location, "Tile metadata semantics are not checked");
    }
    volume(node.boundingVolume, location + "/boundingVolume", ctx);
    if (!nonnegative(node.geometricError)) {
      ctx.error("GEOMETRIC_ERROR", location + "/geometricError", "Expected a finite nonnegative number");
    }
    if (node.refine !== undefined && node.refine !== "ADD" && node.refine !== "REPLACE") {
      ctx.error("REFINE", location + "/refine", "refine must be ADD or REPLACE");
    } else if (depth === 0 && node.refine === undefined) {
      ctx.error("REFINE_REQUIRED", location + "/refine", "Root tile must define refine");
    }
    if (node.transform !== undefined) {
      if (!Array.isArray(node.transform) || node.transform.length !== 16 || !node.transform.every(finite)) {
        ctx.error("TRANSFORM", location + "/transform", "Expected 16 finite matrix values");
      } else if (node.transform[3] !== 0 || node.transform[7] !== 0 ||
          node.transform[11] !== 0 || node.transform[15] !== 1) {
        ctx.error("TRANSFORM_AFFINE", location + "/transform", "Transform must be an affine 4x4 matrix");
      }
    }
    const implicit = node.implicitTiling ?? node.extensions?.["3DTILES_implicit_tiling"];
    if (implicit !== undefined) {
      if (version === "1.0" && !extensionsUsed.includes("3DTILES_implicit_tiling")) {
        ctx.error("IMPLICIT_EXTENSION", location, "3D Tiles 1.0 implicit tiling must be declared in extensionsUsed");
      }
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
          const extensionContents = node.extensions?.["3DTILES_multiple_contents"]?.contents;
          const expectedContentCount = node.content !== undefined ? 1 :
            Array.isArray(node.contents) ? node.contents.length :
              Array.isArray(extensionContents) ? extensionContents.length : 0;
          const rootSubtree = template
            .replaceAll("{level}", "0").replaceAll("{x}", "0")
            .replaceAll("{y}", "0").replaceAll("{z}", "0");
          await resource(rootSubtree, source, location + "/implicitTiling/rootSubtree", "subtree",
            { expectedContentCount });
          ctx.warn("IMPLICIT_PARTIAL", location,
            "Only root subtree file is checked; deeper subtree availability is not traversed");
          ctx.cover("partial", "implicit-tree", location,
            "Only the root subtree is inspected; deeper subtree links and availability are not traversed");
        }
      }
      if (node.children !== undefined) {
        ctx.error("IMPLICIT_CHILDREN", location, "Implicit root must not define explicit children");
      }
    }
    const contentEntries = [];
    if (node.content !== undefined && node.contents !== undefined) {
      ctx.error("CONTENT_COLLECTION", location, "A tile cannot define both content and contents");
    }
    if (node.content !== undefined) contentEntries.push({ content: node.content, path: location + "/content" });
    if (node.contents !== undefined) {
      if (!Array.isArray(node.contents) || node.contents.length === 0) {
        ctx.error("CONTENTS", location, "contents must be a nonempty array");
      } else {
        for (let i = 0; i < node.contents.length; i++) {
          contentEntries.push({ content: node.contents[i], path: location + "/contents/" + i });
        }
      }
      if (version === "1.0") {
        ctx.error("CONTENTS_VERSION", location,
          "Top-level contents requires 3D Tiles 1.1; use the declared 1.0 extension field");
      }
    }
    if (node.extensions !== undefined && !record(node.extensions)) {
      ctx.error("TILE_EXTENSIONS", location + "/extensions", "extensions must be an object");
    }
    if (record(node.extensions)) {
      for (const extensionName of Object.keys(node.extensions)) {
        if (!extensionsUsed.includes(extensionName)) {
          ctx.error("TILE_EXTENSION_UNDECLARED", location + "/extensions/" + extensionName,
            "Tile extension must be listed in extensionsUsed");
        }
      }
    }
    const multipleContents = node.extensions?.["3DTILES_multiple_contents"];
    if (multipleContents !== undefined) {
      if (version !== "1.0") {
        ctx.warn("MULTIPLE_CONTENTS_EXTENSION_UNVERIFIED", location,
          "The 3D Tiles 1.0 multiple contents extension object is not interpreted for this tileset version");
        ctx.cover("skipped", "multiple-contents-extension", location,
          "Multiple contents extension object is only interpreted for 3D Tiles 1.0");
      } else if (!record(multipleContents)) {
        ctx.error("MULTIPLE_CONTENTS_EXTENSION", location, "multiple contents extension must be an object");
      } else if (node.content !== undefined) {
        ctx.error("MULTIPLE_CONTENTS_CONTENT", location,
          "content must be omitted when the multiple contents extension is used");
      } else if (!Array.isArray(multipleContents.contents) || multipleContents.contents.length === 0) {
        ctx.error("MULTIPLE_CONTENTS", location, "Extension contents must be a nonempty array");
      } else {
        for (let i = 0; i < multipleContents.contents.length; i++) {
          contentEntries.push({
            content: multipleContents.contents[i],
            path: location + "/extensions/3DTILES_multiple_contents/contents/" + i,
          });
        }
        ctx.cover("checked", "multiple-contents-extension", location,
          "Declared 3D Tiles 1.0 multiple contents entries and their resources are checked");
      }
    }
    for (const entry of contentEntries) {
      const content = entry.content;
      const contentPath = entry.path;
      if (!record(content)) {
        ctx.error("CONTENT", contentPath, "Content must be an object");
        continue;
      }
      if (content.boundingVolume !== undefined) {
        volume(content.boundingVolume, contentPath + "/boundingVolume", ctx);
      }
      if (content.group !== undefined &&
          (!Number.isSafeInteger(content.group) || content.group < 0 || content.group >= groupCount)) {
        ctx.error("CONTENT_GROUP", contentPath + "/group",
          "content.group must reference an existing tileset group");
      }
      if (content.metadata !== undefined) {
        ctx.warn("CONTENT_METADATA_UNVERIFIED", contentPath,
          "Content metadata semantics are not checked");
        ctx.cover("skipped", "content-metadata", contentPath,
          "Content metadata semantics are not checked");
      }
      const uri = content.uri ?? content.url;
      if (typeof uri !== "string" || uri.length === 0) {
        ctx.error("CONTENT_URI", contentPath, "Content uri/url is required");
      } else if (implicit !== undefined) {
        ctx.warn("IMPLICIT_CONTENT_UNVERIFIED", contentPath,
          "Implicit content URI template instances are not traversed");
        ctx.cover("skipped", "implicit-content", contentPath,
          "Content URI template instances are not traversed");
      } else {
        await resource(uri, source, contentPath);
      }
    }
    if (node.children !== undefined && implicit === undefined) {
      if (!Array.isArray(node.children)) {
        ctx.error("CHILDREN", location + "/children", "children must be an array");
      } else {
        for (let i = 0; i < node.children.length; i++) {
          await tile(node.children[i], location + "/children/" + i, depth + 1,
            source, version, extensionsUsed, groupCount);
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
      ctx.cover("checked", "tileset-json", file, "Tileset JSON fields and declared version");
      if (json.schema !== undefined && json.schemaUri !== undefined) {
        ctx.error("TILESET_SCHEMA", file, "schema and schemaUri are mutually exclusive");
      }
      for (const field of ["extensionsUsed", "extensionsRequired"]) {
        if (json[field] !== undefined && (!Array.isArray(json[field]) || json[field].length === 0 ||
            json[field].some((value) => typeof value !== "string" || value.length === 0) ||
            new Set(json[field]).size !== json[field].length)) {
          ctx.error("TILESET_EXTENSIONS", file + "#/" + field,
            field + " must be a nonempty array of unique nonempty extension names");
        }
      }
      const extensionsUsed = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
      const recognizedExtensions = new Set(["3DTILES_implicit_tiling", "3DTILES_multiple_contents"]);
      for (const extension of extensionsUsed) {
        if (typeof extension === "string" && !recognizedExtensions.has(extension)) {
          ctx.warn("EXTENSION_UNVERIFIED", file + "#/extensionsUsed",
            "Extension semantics are not checked: " + extension);
          ctx.cover("skipped", "extension", file + "#/extensionsUsed",
            "No structural checker is implemented for extension " + extension);
        }
      }
      if (Array.isArray(json.extensionsRequired)) {
        const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
        for (const extension of json.extensionsRequired) {
          if (!used.includes(extension)) {
            ctx.error("TILESET_EXTENSIONS_REQUIRED", file + "#/extensionsRequired",
              "Every required extension must also appear in extensionsUsed");
            break;
          }
        }
      }
      if (json.asset?.version === "1.0" && extensionsUsed.includes("3DTILES_multiple_contents") &&
          !(Array.isArray(json.extensionsRequired) &&
            json.extensionsRequired.includes("3DTILES_multiple_contents"))) {
        ctx.error("MULTIPLE_CONTENTS_REQUIRED", file + "#/extensionsRequired",
          "3DTILES_multiple_contents must be listed in extensionsRequired for 3D Tiles 1.0");
      }
      let groupCount = 0;
      if (json.groups !== undefined) {
        if (!Array.isArray(json.groups) || json.groups.length === 0) {
          ctx.error("TILESET_GROUPS", file + "#/groups", "groups must be a nonempty array when present");
        } else {
          groupCount = json.groups.length;
        }
      }
      if (["schema", "schemaUri", "metadata", "statistics", "properties"].some((key) => json[key] !== undefined) ||
          json.groups !== undefined) {
        ctx.warn("TILESET_METADATA_UNVERIFIED", file,
          "Tileset metadata and schema semantics are not structurally validated");
        ctx.cover("skipped", "tileset-metadata", file,
          "Tileset metadata, statistics, groups, or schema semantics are not checked");
      }
      if (typeof json.schemaUri === "string") {
        await ctx.checkReference(json.schemaUri, file, file + "#/schemaUri");
      } else if (json.schemaUri !== undefined && typeof json.schemaUri !== "string") {
        ctx.error("TILESET_SCHEMA_URI", file + "#/schemaUri", "schemaUri must be a string");
      }
      if (!nonnegative(json.geometricError)) {
        ctx.error("TILESET_GEOMETRIC_ERROR", file, "Expected finite nonnegative geometricError");
      }
      if (json.root === undefined) {
        ctx.error("TILESET_ROOT", file, "Missing root tile");
      } else {
        await tile(json.root, file + "#/root", 0, file, json.asset?.version,
          extensionsUsed, groupCount);
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
  if (!options.checkContent && contentCheckSkipped) {
    ctx.warn("CONTENT_SKIPPED", entry, "Content checking was disabled");
    ctx.cover("skipped", "content", entry, "Content checking was disabled by option");
  }
  return result(ctx);
}

function result(ctx) {
  const coverage = ctx.coverageReport();
  const valid = !ctx.issues.some((issue) => issue.severity === "ERROR");
  return {
    valid,
    passed: valid && (!ctx.options.failOnUnverified || coverage.status === "complete"),
    conformance: "partial",
    issues: ctx.issues,
    stats: ctx.stats,
    coverage,
  };
}

export { DEFAULTS as validationLimits };
