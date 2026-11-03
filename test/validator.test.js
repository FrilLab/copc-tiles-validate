import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateTileset } from "../src/index.js";

const box = [0,0,0, 1,0,0, 0,1,0, 0,0,1];
const data = (tile, version = "1.1") => ({
  asset: { version }, geometricError: 0,
  root: { boundingVolume: { box }, geometricError: 0, refine: "REPLACE", ...tile },
});
async function temporary(callback) {
  const dir = await mkdtemp(join(tmpdir(), "tiles-validate-"));
  try { await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function glb(document = { asset: { version: "2.0" } }, extraChunks = []) {
  const text = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(json);
  const chunkBytes = extraChunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0);
  const bytes = Buffer.alloc(20 + json.length + chunkBytes);
  bytes.write("glTF", 0, 4);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.write("JSON", 16, 4);
  json.copy(bytes, 20);
  let offset = 20 + json.length;
  for (const chunk of extraChunks) {
    bytes.writeUInt32LE(chunk.bytes.length, offset);
    bytes.write(chunk.type, offset + 4, 4, "ascii");
    chunk.bytes.copy(bytes, offset + 8);
    offset += 8 + chunk.bytes.length;
  }
  return bytes;
}
function subtree(document = {
  tileAvailability: { constant: 1 },
  contentAvailability: [{ constant: 1 }],
  childSubtreeAvailability: { constant: 0 },
}, binary = Buffer.alloc(0)) {
  const text = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(text.length / 8) * 8, 32);
  text.copy(json);
  const bytes = Buffer.alloc(24 + json.length + binary.length);
  bytes.write("subt", 0, 4);
  bytes.writeUInt32LE(1, 4);
  bytes.writeBigUInt64LE(BigInt(json.length), 8);
  bytes.writeBigUInt64LE(BigInt(binary.length), 16);
  json.copy(bytes, 24);
  binary.copy(bytes, 24 + json.length);
  return bytes;
}
const codes = (report) => report.issues.map((issue) => issue.code);

test("accepts local 3D Tiles 1.1 and structurally valid GLB", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.glb"), glb());
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "p.glb" } })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.passed, true);
    assert.equal(report.conformance, "partial");
    assert.equal(report.stats.glbs, 1);
    assert.ok(codes(report).includes("GLTF_SEMANTICS_UNVERIFIED"));
    assert.equal(report.coverage.status, "partial");
    assert.ok(report.coverage.checked.some((entry) => entry.kind === "glb-container"));
    assert.ok(report.coverage.partial.some((entry) => entry.kind === "gltf-semantics"));
    const strict = await validateTileset(dir, { failOnUnverified: true });
    assert.equal(strict.valid, true);
    assert.equal(strict.passed, false);
  });
});

test("identifies GLB content by magic when the URI has no file extension", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "content"), glb());
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "content" } })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.glbs, 1);
    assert.ok(!codes(report).includes("CONTENT_FORMAT_UNVERIFIED"));
  });
});

test("accepts 3D Tiles 1.0 JSON and warns about unsupported content format", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.pnts"), "placeholder");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { url: "p.pnts" } }, "1.0")));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.ok(codes(report).includes("CONTENT_FORMAT_UNVERIFIED"));
    assert.equal(report.coverage.status, "incomplete");
    assert.ok(report.coverage.skipped.some((entry) => entry.kind === "content-format"));
  });
});

test("does not misclassify standalone glTF JSON as an external tileset", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "asset.gltf"), JSON.stringify({ asset: { version: "2.0" } }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { url: "asset.gltf" } }, "1.0")));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.ok(codes(report).includes("CONTENT_FORMAT_UNVERIFIED"));
    assert.equal(report.stats.tilesets, 1);
  });
});

test("reports skipped content and applies strict policy without changing valid", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.pnts"), "placeholder");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "p.pnts" } }, "1.0")));
    const report = await validateTileset(dir, { failOnUnverified: true });
    assert.equal(report.valid, true);
    assert.equal(report.passed, false);
    const skipped = await validateTileset(dir, { checkContent: false, failOnUnverified: true });
    assert.equal(skipped.valid, true);
    assert.equal(skipped.passed, false);
    assert.ok(skipped.coverage.skipped.some((entry) => entry.kind === "content"));
  });
});

test("rejects invalid geometry", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      geometricError: -5, boundingVolume: { sphere: [0,0,0,-2] },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes("BOUNDING_VOLUME_RADIUS"));
    assert.ok(codes(report).includes("GEOMETRIC_ERROR"));
  });
});

test("rejects URI traversal and unsupported scheme", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ contents: [
      { uri: "%2e%2e/escape.glb" }, { uri: "file:///tmp/private.glb" },
    ] })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes("URI_ESCAPE"));
    assert.ok(codes(report).includes("EXTERNAL_UNVERIFIED"));
  });
});

test("reports query-bearing references as unverified instead of malformed", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      content: { uri: "point.glb?signature=abc" },
    })));
    const report = await validateTileset(dir, { failOnUnverified: true });
    assert.equal(report.valid, true);
    assert.equal(report.passed, false);
    assert.ok(codes(report).includes("URI_REFERENCE_UNVERIFIED"));
    assert.ok(report.coverage.skipped.some((entry) => entry.kind === "resource"));
  });
});

test("accepts a percent-escaped percent sign in a local resource filename", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "100%.pnts"), "placeholder");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      content: { uri: "100%25.pnts" },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.ok(codes(report).includes("CONTENT_FORMAT_UNVERIFIED"));
    assert.ok(!codes(report).includes("URI_UNSAFE"));
  });
});

test("rejects symlink escape", async () => {
  await temporary(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), "tiles-outside-"));
    try {
      await writeFile(join(outside, "p.glb"), glb());
      await symlink(join(outside, "p.glb"), join(dir, "p.glb"));
      await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "p.glb" } })));
      const report = await validateTileset(dir);
      assert.ok(codes(report).includes("URI_SYMLINK_ESCAPE"));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test("rejects corrupt GLB header", async () => {
  await temporary(async (dir) => {
    const bytes = glb();
    bytes.write("BAD!", 0, 4);
    await writeFile(join(dir, "bad.glb"), bytes);
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "bad.glb" } })));
    assert.ok(codes(await validateTileset(dir)).includes("GLB_MAGIC"));
  });
});

test("rejects duplicate and misordered GLB chunks", async () => {
  await temporary(async (dir) => {
    const duplicate = glb({ asset: { version: "2.0" } }, [
      { type: "BIN\0", bytes: Buffer.alloc(4) },
      { type: "BIN\0", bytes: Buffer.alloc(4) },
    ]);
    const lateBin = glb({ asset: { version: "2.0" } }, [
      { type: "UNKN", bytes: Buffer.alloc(4) },
      { type: "BIN\0", bytes: Buffer.alloc(4) },
    ]);
    for (const [name, bytes] of [["duplicate.glb", duplicate], ["late.glb", lateBin]]) {
      await writeFile(join(dir, name), bytes);
    }
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ contents: [
      { uri: "duplicate.glb" }, { uri: "late.glb" },
    ] })));
    const report = await validateTileset(dir);
    assert.equal(codes(report).filter((code) => code === "GLB_CHUNK_ORDER").length, 2);
  });
});

test("rejects GLB buffer bounds outside the permitted BIN padding", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "bad.glb"), glb(
      { asset: { version: "2.0" }, buffers: [{ byteLength: 5 }] },
      [{ type: "BIN\0", bytes: Buffer.alloc(4) }],
    ));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "bad.glb" } })));
    assert.ok(codes(await validateTileset(dir)).includes("GLTF_BUFFER_RANGE"));
  });
});

test("checks local external GLB buffers for containment and declared bounds", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "short.bin"), Buffer.alloc(2));
    await writeFile(join(dir, "short.glb"), glb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "short.bin" }],
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "short.glb" } })));
    assert.ok(codes(await validateTileset(dir)).includes("GLTF_BUFFER_RANGE"));
  });
  await temporary(async (dir) => {
    await writeFile(join(dir, "bad.glb"), glb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "../outside.bin" }],
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "bad.glb" } })));
    assert.ok(codes(await validateTileset(dir)).includes("URI_ESCAPE"));
  });
});

test("applies the resource limit to local external buffer references", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "external.bin"), Buffer.alloc(4));
    await writeFile(join(dir, "asset.glb"), glb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "external.bin" }],
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "asset.glb" } })));
    const report = await validateTileset(dir, { maxResources: 1 });
    assert.ok(codes(report).includes("RESOURCE_LIMIT"));
  });
});

test("inspects a resource after it was first counted as a URI reference", async () => {
  await temporary(async (dir) => {
    const brokenGlb = Buffer.alloc(32);
    brokenGlb.write("BAD!", 0, 4);
    await writeFile(join(dir, "broken.glb"), brokenGlb);
    await writeFile(join(dir, "tileset.json"), JSON.stringify({
      ...data({ content: { uri: "broken.glb" } }),
      schemaUri: "broken.glb",
    }));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("GLB_MAGIC"));
    assert.equal(report.stats.glbs, 1);
  });
  await temporary(async (dir) => {
    await writeFile(join(dir, "shared.glb"), glb());
    await writeFile(join(dir, "container.glb"), glb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 1, uri: "shared.glb" }],
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      content: { uri: "container.glb" },
      children: [{ boundingVolume: { box }, geometricError: 0, content: { uri: "shared.glb" } }],
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.glbs, 2);
  });
});

test("rejects missing required tile fields and invalid content collections", async () => {
  await temporary(async (dir) => {
    const invalid = {
      asset: { version: "1.1" }, geometricError: 0,
      root: { boundingVolume: { box }, geometricError: 0, content: { uri: "missing.glb" }, contents: [] },
    };
    await writeFile(join(dir, "tileset.json"), JSON.stringify(invalid));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("REFINE_REQUIRED"));
    assert.ok(codes(report).includes("CONTENTS"));
    assert.ok(codes(report).includes("CONTENT_COLLECTION"));
  });
});

test("rejects unsupported implicit URI placeholders and 1.0 content collections", async () => {
  await temporary(async (dir) => {
    const invalid = data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 2, subtrees: { uri: "subtrees/{level}/{x}/{y}/{tile}.subtree" } },
      contents: [{ uri: "content/{level}/{x}/{y}.glb" }],
    }, "1.0");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(invalid));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("IMPLICIT_TEMPLATE"));
    assert.ok(codes(report).includes("CONTENTS_VERSION"));
  });
});

test("traverses 3D Tiles 1.0 multiple contents extension resources", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "present.glb"), glb());
    await writeFile(join(dir, "tileset.json"), JSON.stringify({
      ...data({ extensions: { "3DTILES_multiple_contents": { contents: [
        { uri: "present.glb" }, { uri: "missing.glb" },
      ] } } }, "1.0"),
      extensionsUsed: ["3DTILES_multiple_contents"],
      extensionsRequired: ["3DTILES_multiple_contents"],
    }));
    const report = await validateTileset(dir);
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes("RESOURCE_MISSING"));
    assert.equal(report.stats.glbs, 1);
    assert.ok(report.coverage.checked.some((entry) => entry.kind === "multiple-contents-extension"));
  });
});

test("rejects a non-affine tile transform and inconsistent extension declarations", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify({
      ...data({ transform: [1,0,0,1, 0,1,0,0, 0,0,1,0, 0,0,0,1] }),
      extensionsRequired: ["EXT_required"], extensionsUsed: [],
    }));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("TRANSFORM_AFFINE"));
    assert.ok(codes(report).includes("TILESET_EXTENSIONS_REQUIRED"));
  });
});

test("marks undeclared extension semantics as skipped coverage", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify({
      ...data({}), extensionsUsed: ["VENDOR_custom_tiles"],
    }));
    const report = await validateTileset(dir, { failOnUnverified: true });
    assert.equal(report.valid, true);
    assert.equal(report.passed, false);
    assert.ok(codes(report).includes("EXTENSION_UNVERIFIED"));
    assert.ok(report.coverage.skipped.some((entry) => entry.kind === "extension"));
  });
});

test("validates schema and group structure and keeps schemaUri within the root", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "content.glb"), glb());
    await writeFile(join(dir, "tileset.json"), JSON.stringify({
      ...data({ content: { uri: "content.glb", group: 0 } }),
      schema: {}, schemaUri: "../schema.json", groups: [],
    }));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("TILESET_SCHEMA"));
    assert.ok(codes(report).includes("TILESET_GROUPS"));
    assert.ok(codes(report).includes("CONTENT_GROUP"));
    assert.ok(codes(report).includes("URI_ESCAPE"));
  });
});

test("validates root implicit subtree, reports limited coverage", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree({
      tileAvailability: { constant: 1 },
      contentAvailability: [{ constant: 0 }],
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
      content: { uri: "c/{level}/{x}/{y}.glb" },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.subtrees, 1);
    assert.ok(report.coverage.checked.some((entry) => entry.kind === "subtree-availability"));
    assert.ok(!codes(report).includes("IMPLICIT_PARTIAL"));
  });
});

test("traverses reachable child subtrees and follows only available references", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await mkdir(join(dir, "subtrees", "1", "1"), { recursive: true });
    const rootDocument = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 8, byteLength: 1 },
      ],
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { bitstream: 1, availableCount: 1 },
    };
    const rootBinary = Buffer.alloc(16);
    rootBinary[8] = 8;
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), subtree(rootDocument, rootBinary));
    await writeFile(join(dir, "subtrees", "1", "1", "1.json"), JSON.stringify({
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 3, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.stats.subtrees, 2);
    assert.ok(!codes(report).includes("RESOURCE_MISSING"));
  });
});

test("applies maxDepth before requesting a child subtree", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const document = {
      buffers: [{ byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteLength: 2 }],
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { bitstream: 0 },
    };
    const binary = Buffer.alloc(8);
    binary[0] = 1;
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), subtree(document, binary));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir, { maxDepth: 1 });
    assert.ok(codes(report).includes("TILE_LIMIT"));
    assert.ok(!codes(report).includes("RESOURCE_MISSING"));
    assert.equal(report.stats.subtrees, 1);
  });
});

test("bounds dense child subtree availability traversal with maxTiles", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 1 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 3,
        availableLevels: 8, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir, { maxTiles: 2, maxResources: 10 });
    assert.ok(codes(report).includes("TILE_LIMIT"));
    assert.equal(report.stats.subtrees, 1);
    assert.ok(report.stats.resources <= 1);
  });
});

test("applies maxResources to reachable subtree traversal", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 1 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 3, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir, { maxResources: 1 });
    assert.ok(codes(report).includes("RESOURCE_LIMIT"));
    assert.equal(report.stats.subtrees, 1);
    assert.ok(!codes(report).includes("RESOURCE_MISSING"));
  });
});

test("checks content URIs only for available content bits", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await mkdir(join(dir, "content", "0", "0"), { recursive: true });
    await writeFile(join(dir, "content", "0", "0", "0.glb"), glb());
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 },
      contentAvailability: [{ constant: 1 }],
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 2, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
      content: { uri: "content/{level}/{x}/{y}.glb" },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.stats.glbs, 1);
  });
});

test("reports missing reachable child subtrees and available content resources", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const rootDocument = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 8, byteLength: 1 },
      ],
      tileAvailability: { constant: 1 },
      contentAvailability: [{ constant: 1 }],
      childSubtreeAvailability: { bitstream: 1 },
    };
    const binary = Buffer.alloc(16);
    binary[8] = 1;
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), subtree(rootDocument, binary));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 3, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
      content: { uri: "content/{level}/{x}/{y}.glb" },
    })));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("RESOURCE_MISSING"));
    assert.ok(report.issues.some((issue) => issue.path.includes("contentAvailability")));
  });
});

test("rejects child subtree symlinks that escape the input root", async () => {
  await temporary(async (dir) => {
    const root = join(dir, "tiles");
    const childPath = join(root, "subtrees", "1", "0", "0.json");
    await mkdir(join(root, "subtrees", "0", "0"), { recursive: true });
    await mkdir(join(root, "subtrees", "1", "0"), { recursive: true });
    await writeFile(join(dir, "outside.json"), JSON.stringify({
      tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 0 },
    }));
    const document = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 8, byteLength: 1 },
      ],
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { bitstream: 1 },
    };
    const binary = Buffer.alloc(16);
    binary[8] = 1;
    await writeFile(join(root, "subtrees", "0", "0", "0.json"), subtree(document, binary));
    await symlink(join(dir, "outside.json"), childPath);
    await writeFile(join(root, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 3, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    assert.ok(codes(await validateTileset(join(root, "tileset.json")))
      .includes("URI_SYMLINK_ESCAPE"));
  });
});

test("does not request content or child subtrees beneath unavailable tiles", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const document = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 8, byteLength: 1 },
      ],
      tileAvailability: { bitstream: 0 },
      contentAvailability: [{ bitstream: 1 }],
      childSubtreeAvailability: { constant: 0 },
    };
    const binary = Buffer.alloc(16);
    binary[0] = 1;
    binary[8] = 2;
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree(document, binary));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
      content: { uri: "missing-content/{level}/{x}/{y}.glb" },
    })));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("SUBTREE_CONTENT_TILE_UNAVAILABLE"));
    assert.ok(!codes(report).includes("RESOURCE_MISSING"));
  });
});

test("rejects available tiles and child subtrees with unavailable parents", async () => {
  for (const [subtreeLevels, document, binary, expectedCode] of [
    [3, {
      buffers: [{ byteLength: 16 }],
      bufferViews: [{ buffer: 0, byteLength: 3 }],
      tileAvailability: { bitstream: 0 },
      childSubtreeAvailability: { constant: 0 },
    }, Buffer.from([0x21, 0, 0, ...Array(13).fill(0)]), "SUBTREE_TILE_PARENT_UNAVAILABLE"],
    [2, {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 8, byteLength: 2 },
      ],
      tileAvailability: { bitstream: 0 },
      childSubtreeAvailability: { bitstream: 1 },
    }, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    "SUBTREE_CHILD_PARENT_UNAVAILABLE"],
  ]) {
    await temporary(async (dir) => {
      await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
      await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree(document, binary));
      await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
        implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels,
          availableLevels: 5, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
      })));
      const report = await validateTileset(dir);
      assert.ok(codes(report).includes(expectedCode), expectedCode);
      assert.ok(!codes(report).includes("RESOURCE_MISSING"));
    });
  }
});

test("checks availability bit lengths, padding, counts, and traversal bounds", async () => {
  for (const [document, binary, expectedCode] of [
    [{ buffers: [{ byteLength: 16 }], bufferViews: [{ buffer: 0, byteLength: 8 }],
      tileAvailability: { bitstream: 0 }, childSubtreeAvailability: { constant: 0 } },
      Buffer.alloc(16), "SUBTREE_BITSTREAM_LENGTH"],
    [{ buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0 }, childSubtreeAvailability: { constant: 0 } },
      Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0]), "SUBTREE_BITSTREAM_PADDING"],
    [{ buffers: [{ byteLength: 8 }], bufferViews: [{ buffer: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0, availableCount: 0 }, childSubtreeAvailability: { constant: 0 } },
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), "SUBTREE_AVAILABLE_COUNT"],
  ]) {
    await temporary(async (dir) => {
      await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
      await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree(document, binary));
      await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
        implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
          availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
      })));
      assert.ok(codes(await validateTileset(dir)).includes(expectedCode), expectedCode);
    });
  }
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1000000,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    assert.ok(codes(await validateTileset(dir, { maxFileBytes: 128 }))
      .includes("SUBTREE_AVAILABILITY_LIMIT"));
  });
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const bytes = Buffer.alloc(24);
    bytes.write("subt", 0, 4, "ascii");
    bytes.writeUInt32LE(1, 4);
    bytes.writeBigUInt64LE((1n << 63n), 8);
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), bytes);
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1,
        availableLevels: 2, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("JSON_LIMIT"));
  });
});

test("rejects availability beyond availableLevels while allowing longer subtrees", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 1, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("SUBTREE_LEVEL_AVAILABILITY"));
  });
});

test("inspects a JSON format implicit subtree", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.subtrees, 1);
    assert.ok(report.coverage.checked.some((entry) => entry.kind === "subtree-json"));
  });
});

test("accepts subtreeLevels greater than availableLevels", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const document = {
      buffers: [{ byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0, availableCount: 1 },
      childSubtreeAvailability: { constant: 0 },
    };
    const binary = Buffer.alloc(8);
    binary[0] = 1;
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree(document, binary));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 1, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.ok(!codes(report).includes("IMPLICIT_LEVELS"));
  });
});

test("requires subtree content availability for every declared implicit content", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
      content: { uri: "content/{level}/{x}/{y}.glb" },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("SUBTREE_CONTENT_AVAILABILITY_MISSING"));
  });
});

test("checks shared subtree content availability against every implicit root", async () => {
  for (const contentCounts of [[1, 2], [2, 1]]) {
    await temporary(async (dir) => {
      await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
      await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
        tileAvailability: { constant: 1 },
        contentAvailability: [{ constant: 1 }],
        childSubtreeAvailability: { constant: 0 },
      }));
      const implicitRoot = (contentCount) => ({
        boundingVolume: { box }, geometricError: 0,
        implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
          availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
        contents: Array.from({ length: contentCount }, (_, i) => ({ uri: "content" + i + "/{level}.glb" })),
      });
      await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
        children: contentCounts.map(implicitRoot),
      })));
      const report = await validateTileset(dir);
      assert.ok(codes(report).includes("SUBTREE_CONTENT_AVAILABILITY_COUNT"));
      assert.equal(report.stats.subtrees, 1);
    });
  }
});

test("checks JSON subtree buffer URIs against the input root", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      buffers: [{ byteLength: 8, uri: "../../../../outside.bin" }],
      tileAvailability: { constant: 1 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("URI_ESCAPE"));
  });
});

test("reads availability bitstreams from bounded local external buffers", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const binary = Buffer.alloc(8);
    binary[0] = 1;
    await writeFile(join(dir, "subtrees", "0", "0", "availability.bin"), binary);
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      buffers: [{ uri: "availability.bin", byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.stats.resources, 2);
    assert.ok(report.coverage.checked.some((entry) => entry.kind === "subtree-buffer"));
  });
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.json"), JSON.stringify({
      buffers: [{ uri: "missing.bin", byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.json" } },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("RESOURCE_MISSING"));
  });
});

test("rejects malformed subtree availability counts", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree({
      tileAvailability: { constant: 1, availableCount: -1 },
      childSubtreeAvailability: { constant: 0 },
    }));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
    })));
    assert.ok(codes(await validateTileset(dir)).includes("SUBTREE_AVAILABLE_COUNT"));
  });
});

test("rejects unaligned and out-of-range subtree buffer views", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    const subtreeJson = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [
        { buffer: 0, byteOffset: 1, byteLength: 8 },
        { buffer: 0, byteOffset: 8, byteLength: 16 },
      ],
      tileAvailability: { bitstream: 0 },
      childSubtreeAvailability: { constant: 0 },
    };
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree(subtreeJson, Buffer.alloc(16)));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
    })));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("SUBTREE_BUFFER_VIEW"));
    assert.ok(codes(report).includes("SUBTREE_BUFFER_VIEW_RANGE"));
  });
});

test("detects cyclic references to external tilesets", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "second.json" } })));
    await writeFile(join(dir, "second.json"), JSON.stringify(data({ content: { uri: "second.json" } })));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("TILESET_CYCLE"));
    assert.equal(report.valid, false);
  });
});

test("identifies an extensionless external tileset from its required fields", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "child"), JSON.stringify(data({})));
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "child" } })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.tilesets, 2);
  });
});

test("enforces tile count and JSON input bounds", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      children: [{ boundingVolume: { box }, geometricError: 0 }],
    })));
    assert.ok(codes(await validateTileset(dir, { maxTiles: 1 })).includes("TILE_LIMIT"));
    assert.ok(codes(await validateTileset(dir, { maxJsonBytes: 10 })).includes("JSON_LIMIT"));
  });
});

test("CLI JSON output and failure code", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "missing.glb" } })));
    const command = spawnSync(process.execPath, ["src/cli.js", dir, "--json"],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(command.status, 1);
    assert.ok(codes(JSON.parse(command.stdout)).includes("RESOURCE_MISSING"));
  });
});

test("CLI strict mode fails for structurally valid but unverified content", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.pnts"), "placeholder");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { url: "p.pnts" } }, "1.0")));
    const command = spawnSync(process.execPath,
      ["src/cli.js", dir, "--json", "--fail-on-unverified"],
      { cwd: process.cwd(), encoding: "utf8" });
    const report = JSON.parse(command.stdout);
    assert.equal(command.status, 1);
    assert.equal(report.valid, true);
    assert.equal(report.passed, false);
  });
});

test("returns an explicit unsupported-format error for archive inputs", async () => {
  await temporary(async (dir) => {
    const archive = join(dir, "sample.3tz");
    await writeFile(archive, "not-an-archive");
    const report = await validateTileset(archive);
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes("PACKAGE_UNSUPPORTED"));
  });
});
