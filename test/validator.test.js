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
  root: { boundingVolume: { box }, geometricError: 0, ...tile },
});
async function temporary(callback) {
  const dir = await mkdtemp(join(tmpdir(), "tiles-validate-"));
  try { await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function glb() {
  const text = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 0 }] }));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(json);
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write("glTF", 0, 4);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.write("JSON", 16, 4);
  json.copy(bytes, 20);
  return bytes;
}
function subtree() {
  const text = Buffer.from(JSON.stringify({
    tileAvailability: { constant: 1 },
    contentAvailability: [{ constant: 1 }],
    childSubtreeAvailability: { constant: 0 },
  }));
  const json = Buffer.alloc(Math.ceil(text.length / 8) * 8, 32);
  text.copy(json);
  const bytes = Buffer.alloc(24 + json.length);
  bytes.write("subt", 0, 4);
  bytes.writeUInt32LE(1, 4);
  bytes.writeBigUInt64LE(BigInt(json.length), 8);
  bytes.writeBigUInt64LE(0n, 16);
  json.copy(bytes, 24);
  return bytes;
}
const codes = (report) => report.issues.map((issue) => issue.code);

test("accepts local 3D Tiles 1.1 and structurally valid GLB", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.glb"), glb());
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "p.glb" } })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.conformance, "partial");
    assert.equal(report.stats.glbs, 1);
    assert.ok(codes(report).includes("GLTF_SEMANTICS_UNVERIFIED"));
  });
});

test("accepts 3D Tiles 1.0 JSON and warns about unsupported content format", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "p.pnts"), "placeholder");
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { url: "p.pnts" } }, "1.0")));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.ok(codes(report).includes("CONTENT_FORMAT_UNVERIFIED"));
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
    assert.ok(codes(report).includes("URI_UNSUPPORTED"));
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

test("validates root implicit subtree, reports limited coverage", async () => {
  await temporary(async (dir) => {
    await mkdir(join(dir, "subtrees", "0", "0"), { recursive: true });
    await writeFile(join(dir, "subtrees", "0", "0", "0.subtree"), subtree());
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({
      implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2,
        availableLevels: 4, subtrees: { uri: "subtrees/{level}/{x}/{y}.subtree" } },
      content: { uri: "c/{level}/{x}/{y}.glb" },
    })));
    const report = await validateTileset(dir);
    assert.equal(report.valid, true);
    assert.equal(report.stats.subtrees, 1);
    assert.ok(codes(report).includes("IMPLICIT_PARTIAL"));
  });
});

test("detects cyclic references to external tilesets", async () => {
  await temporary(async (dir) => {
    await writeFile(join(dir, "tileset.json"), JSON.stringify(data({ content: { uri: "second.json" } })));
    await writeFile(join(dir, "second.json"), JSON.stringify(data({ content: { uri: "tileset.json" } })));
    const report = await validateTileset(dir);
    assert.ok(codes(report).includes("TILESET_CYCLE"));
    assert.equal(report.valid, false);
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

test("returns an explicit unsupported-format error for archive inputs", async () => {
  await temporary(async (dir) => {
    const archive = join(dir, "sample.3tz");
    await writeFile(archive, "not-an-archive");
    const report = await validateTileset(archive);
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes("PACKAGE_UNSUPPORTED"));
  });
});
