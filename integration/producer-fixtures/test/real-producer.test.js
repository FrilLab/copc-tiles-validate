import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCoordinateTransformPlan,
  getPreparedEcefBounds,
  transformPointBufferToPreparedPointData,
} from "@frillab/copc-adapter/core";
import {
  encodePointCloudGlb,
  createExplicitTileset,
  createImplicitOctreeTileset,
  createPaddedEcefBoundsFromConservativeResult,
  getExplicitTileContentUri,
} from "@frillab/copc-tiles";
import { wrapCopcCoreNodeSource } from "@frillab/copc-tiles/adapter/copc-core";
import { TileNodeReader } from "@frillab/copc-tiles";
import { validateTileset } from "../../../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const cliPath = join(repositoryRoot, "src/cli.js");
const expectedHashes = JSON.parse(await readFile(join(testDirectory, "../expected-sha256.json"), "utf8"));
const producerLock = JSON.parse(await readFile(join(testDirectory, "../package-lock.json"), "utf8"));
for (const [name, expected] of Object.entries(expectedHashes.producer)) {
  const locked = producerLock.packages[`node_modules/${name}`];
  assert.equal(locked?.version, expected.version, `${name} version must match the recorded fixture producer`);
  assert.equal(locked?.integrity, expected.integrity, `${name} npm integrity must match the recorded producer artifact`);
}

const nodes = [
  {
    key: "0-0-0-0", level: 0, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 0, pointDataLength: 96,
    children: ["1-0-0-0", "1-1-0-0"], childrenComplete: true,
  },
  {
    key: "1-0-0-0", level: 1, x: 0, y: 0, z: 0,
    pointCount: 2, pointDataOffset: 96, pointDataLength: 64,
    children: [], childrenComplete: true,
  },
  {
    key: "1-1-0-0", level: 1, x: 1, y: 0, z: 0,
    pointCount: 0, pointDataOffset: 160, pointDataLength: 0,
    children: [], childrenComplete: true,
  },
];

const sourceCellBounds = {
  "0-0-0-0": { minX: -2, minY: -2, minZ: -2, maxX: 2, maxY: 2, maxZ: 2 },
  "1-0-0-0": { minX: -2, minY: -2, minZ: -2, maxX: 0, maxY: 0, maxZ: 0 },
  "1-1-0-0": { minX: 0, minY: -2, minZ: -2, maxX: 2, maxY: 0, maxZ: 0 },
};

const coreMetadata = {
  pointCount: 5,
  bounds: { minX: -0.00003, minY: -0.00003, minZ: -1.5, maxX: 0.00003, maxY: 0.00003, maxZ: 1.5 },
  cube: sourceCellBounds["0-0-0-0"],
  scale: { x: 1, y: 1, z: 1 },
  offset: { x: 0, y: 0, z: 0 },
};
const transformPlan = createCoordinateTransformPlan(coreMetadata);

const ecefBounds = {
  "0-0-0-0": { minX: 6378135, minY: -4, minZ: -4, maxX: 6378139, maxY: 4, maxZ: 4 },
  "1-0-0-0": { minX: 6378135, minY: -4, minZ: -4, maxX: 6378137, maxY: 0, maxZ: 0 },
  "1-1-0-0": { minX: 6378137, minY: -4, minZ: -4, maxX: 6378139, maxY: 0, maxZ: 0 },
};

const sourcePoints = {
  "0-0-0-0": [
    [-0.00003, -0.00003, -1.5],
    [0, 0, 0],
    [0.00003, 0.00003, 1.5],
  ],
  "1-0-0-0": [
    [-0.00002, -0.00002, -1],
    [-0.00001, -0.00001, -0.5],
  ],
  "1-1-0-0": [],
};

function makeCoreSource() {
  const page = Object.freeze({ key: "synthetic-root", pageOffset: 0, pageLength: 256 });
  return {
    source: "synthetic-copc-core-source",
    sourceGeneration: 1,
    transformGeneration: 1,
    transformPlan,
    isCurrent(generation = 1) { return generation === 1; },
    getMetadata() {
      return coreMetadata;
    },
    getRootHierarchyPage() { return page; },
    async loadHierarchyPage() { return { nodes, pages: [] }; },
    getNodeCellBounds(key) { return sourceCellBounds[key]; },
    getConservativeNodeEcefBounds(key) {
      const cell = sourceCellBounds[key];
      const bounds = ecefBounds[key];
      return {
        nodeKey: key,
        sourceCellBounds: cell,
        sourceCoordinateSystem: "copc-source",
        sourceIdentity: this.source,
        sourceGeneration: this.sourceGeneration,
        transformGeneration: this.transformGeneration,
        transformPlanIdentity: this.transformPlan.identity.key,
        heightOffsetMeters: 0,
        status: "supported",
        boundsEcef: { coordinateSystem: "wgs84-ecef-meters", ...bounds },
        coverage: "full-source-cell-and-descendant-cells",
        method: "wgs84-geodetic-interval-v1",
        verification: "analytic-interval",
        verticalReference: "ellipsoidal",
        sourceVerticalUnitToMeters: 1,
        encoderErrorPaddingRequired: true,
        assumptions: ["Deterministic synthetic public Core source used only for structural fixture generation."],
      };
    },
    async loadPreparedNodeData(node) {
      const points = sourcePoints[node.key];
      assert.ok(points, `unknown synthetic node ${node.key}`);
      const pointCount = points.length;
      const sourceCoordinates = new Float64Array(points.flatMap(([x, y, z]) => [x, y, z]));
      const attributes = pointCount === 0 ? {} : {
        red: new Uint16Array(points.map((_, i) => 1000 + i)),
        green: new Uint16Array(points.map((_, i) => 2000 + i)),
        blue: new Uint16Array(points.map((_, i) => 3000 + i)),
        intensity: new Uint16Array(points.map((_, i) => 400 + i)),
        classification: new Uint8Array(points.map((_, i) => 2 + i)),
      };
      const pointData = transformPointBufferToPreparedPointData(coreMetadata, {
        pointCount,
        coordinateSystem: "copc-source",
        coordinates: sourceCoordinates,
        attributes,
      });
      const decodedBounds = getPreparedEcefBounds(pointData);
      return {
        node,
        pointData,
        availableFields: new Set(["position", "rgb", "intensity", "classification"]),
        availableExtraDimensions: [],
        ...(decodedBounds === undefined ? {} : { ecefBounds: decodedBounds }),
        ecefBoundsKind: "decoded-point-content",
        sourceIdentity: this.source,
        sourceGeneration: this.sourceGeneration,
        transformGeneration: this.transformGeneration,
        transformPlan: this.transformPlan,
      };
    },
    close() {},
  };
}

function uriPath(root, uri) {
  return join(root, ...uri.split("/"));
}

function materializeTemplate(template, node) {
  return template
    .replaceAll("{level}", String(node.level))
    .replaceAll("{x}", String(node.x))
    .replaceAll("{y}", String(node.y))
    .replaceAll("{z}", String(node.z));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function assertPointCloudGlb(bytes) {
  const container = Buffer.from(bytes);
  assert.equal(container.toString("ascii", 0, 4), "glTF");
  assert.equal(container.readUInt32LE(4), 2);
  assert.equal(container.readUInt32LE(8), container.length);
  assert.equal(container.toString("ascii", 16, 20), "JSON");
  const jsonLength = container.readUInt32LE(12);
  const gltf = JSON.parse(container.toString("utf8", 20, 20 + jsonLength).trim());
  assert.equal(gltf.asset.version, "2.0");
  assert.ok(gltf.meshes.some((mesh) => mesh.primitives.some((primitive) => primitive.mode === 0)),
    "producer GLB must contain a glTF POINTS primitive");
}

async function makeFixtures(directory) {
  const coreSource = wrapCopcCoreNodeSource({
    source: makeCoreSource(),
    sourceIdentity: "synthetic-validator-producer-fixture",
  });
  const reader = new TileNodeReader(coreSource);
  const hierarchy = await reader.readHierarchy();
  assert.equal(hierarchy.nodes.length, 3);
  assert.equal(hierarchy.nodes.find((node) => node.key === "1-1-0-0")?.pointCount, 0);

  const explicitInputs = hierarchy.nodes.map((node) => {
    const bounds = createPaddedEcefBoundsFromConservativeResult(
      coreSource.getConservativeNodeEcefBounds(node.key),
      0,
    );
    return { node, bounds };
  });
  const explicitTileset = createExplicitTileset(explicitInputs);
  const explicitDirectory = join(directory, "explicit");
  await writeJson(join(explicitDirectory, "tileset.json"), explicitTileset);
  const explicitContentCount = { count: 0 };
  for (const node of hierarchy.nodes) {
    const selection = node.pointCount === 0 ? {} : { attributes: { rgb: true, intensity: true, classification: true } };
    const view = await reader.readNode(node, selection);
    const glb = encodePointCloudGlb(view);
    if (node.pointCount === 0) {
      assert.equal(glb, null, "producer should omit content for a zero-point node");
      continue;
    }
    assert.ok(glb?.bytes instanceof Uint8Array);
    assertPointCloudGlb(glb.bytes);
    const contentUri = getExplicitTileContentUri(node.key);
    assert.ok(collectExplicitContentUris(explicitTileset).includes(contentUri));
    await writeBytes(uriPath(explicitDirectory, contentUri), glb.bytes);
    explicitContentCount.count += 1;
  }
  assert.equal(explicitContentCount.count, 2);

  const implicitNodes = hierarchy.nodes.map((node) => ({
    node,
    bounds: {
      minimum: [ecefBounds[node.key].minX, ecefBounds[node.key].minY, ecefBounds[node.key].minZ],
      maximum: [ecefBounds[node.key].maxX, ecefBounds[node.key].maxY, ecefBounds[node.key].maxZ],
    },
  }));
  const implicit = createImplicitOctreeTileset(implicitNodes, { subtreeLevels: 2 });
  const implicitDirectory = join(directory, "implicit");
  await writeJson(join(implicitDirectory, "tileset.json"), implicit.tileset);
  for (const [uri, bytes] of implicit.subtrees) await writeBytes(uriPath(implicitDirectory, uri), bytes);
  const contentTemplate = implicit.tileset.root.content.uri;
  for (const node of hierarchy.nodes) {
    if (node.pointCount === 0) continue;
    const view = await reader.readNode(node, { attributes: { rgb: true, intensity: true, classification: true } });
    const glb = encodePointCloudGlb(view, {
      precision: { originEcef: new Float64Array(implicit.contentOriginEcef) },
    });
    assert.ok(glb?.bytes instanceof Uint8Array);
    assertPointCloudGlb(glb.bytes);
    await writeBytes(uriPath(implicitDirectory, materializeTemplate(contentTemplate, node)), glb.bytes);
  }
  coreSource.close();
  return {
    explicitDirectory,
    implicitDirectory,
    artifactFiles: [
      "explicit/tileset.json",
      ...collectExplicitContentUris(explicitTileset).map((uri) => `explicit/${uri}`),
      "implicit/tileset.json",
      ...[...implicit.subtrees.keys()].map((uri) => `implicit/${uri}`),
      ...hierarchy.nodes.filter((node) => node.pointCount > 0).map((node) => `implicit/${materializeTemplate(contentTemplate, node)}`),
    ],
    explicitTileset,
    implicitTileset: implicit.tileset,
    hierarchyNodes: hierarchy.nodes,
  };
}

function collectExplicitContentUris(tileset) {
  const result = [];
  const pending = [tileset.root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.content?.uri) result.push(current.content.uri);
    pending.push(...(current.children ?? []));
  }
  return result.sort();
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function generatedHashes(directory, artifactFiles) {
  const result = {};
  for (const relativePath of artifactFiles) result[relativePath] = await sha256File(join(directory, relativePath));
  return result;
}

function copyDirectory(source, destination) {
  return cp(source, destination, { recursive: true });
}

async function mutateSubtreeJson(path, mutate) {
  const original = await readFile(path);
  const jsonLength = original.readBigUInt64LE(8);
  const binaryLength = original.readBigUInt64LE(16);
  const start = 24;
  const jsonEnd = start + Number(jsonLength);
  const binary = original.subarray(jsonEnd, jsonEnd + Number(binaryLength));
  const json = JSON.parse(original.toString("utf8", start, jsonEnd).trim());
  mutate(json);
  const text = Buffer.from(JSON.stringify(json));
  const paddedLength = Math.ceil(text.length / 8) * 8;
  const paddedJson = Buffer.alloc(paddedLength, 0x20);
  text.copy(paddedJson);
  const output = Buffer.alloc(24 + paddedLength + binary.length);
  original.copy(output, 0, 0, 8);
  output.writeBigUInt64LE(BigInt(paddedLength), 8);
  output.writeBigUInt64LE(BigInt(binary.length), 16);
  paddedJson.copy(output, 24);
  binary.copy(output, 24 + paddedLength);
  await writeFile(path, output);
}

async function makeCases(root, generated) {
  const cases = [
    {
      name: "explicit valid output", source: generated.explicitDirectory, expectedValid: true,
      expectedCode: null, expectedWarnings: ["GLTF_SEMANTICS_UNVERIFIED"], expectedStats: { glbs: 2, tiles: 3 },
    },
    {
      name: "implicit valid output", source: generated.implicitDirectory, expectedValid: true,
      expectedCode: null, expectedWarnings: ["SUBTREE_SEMANTICS_UNVERIFIED", "IMPLICIT_PARTIAL", "IMPLICIT_CONTENT_UNVERIFIED"],
      expectedStats: { subtrees: 1, tiles: 1 },
    },
  ];

  const negativeCases = [
    {
      name: "generated GLB has malformed magic",
      source: generated.explicitDirectory,
      mutate: async (directory) => {
        const tileset = JSON.parse(await readFile(join(directory, "tileset.json"), "utf8"));
        const content = tileset.root.content.uri;
        const path = uriPath(directory, content);
        const bytes = await readFile(path);
        bytes.write("BAD!", 0, 4, "ascii");
        await writeFile(path, bytes);
      },
      expectedCode: "GLB_MAGIC",
    },
    {
      name: "generated GLB has a mismatched declared file length",
      source: generated.explicitDirectory,
      mutate: async (directory) => {
        const tileset = JSON.parse(await readFile(join(directory, "tileset.json"), "utf8"));
        const path = uriPath(directory, tileset.root.content.uri);
        const bytes = await readFile(path);
        bytes.writeUInt32LE(bytes.length - 4, 8);
        await writeFile(path, bytes);
      },
      expectedCode: "GLB_LENGTH",
    },
    {
      name: "generated GLB has an invalid chunk length",
      source: generated.explicitDirectory,
      mutate: async (directory) => {
        const tileset = JSON.parse(await readFile(join(directory, "tileset.json"), "utf8"));
        const path = uriPath(directory, tileset.root.content.uri);
        const bytes = await readFile(path);
        bytes.writeUInt32LE(0xffffffff, 12);
        await writeFile(path, bytes);
      },
      expectedCode: "GLB_CHUNK_LENGTH",
    },
    {
      name: "producer-generated explicit tileset references a missing URI",
      source: generated.explicitDirectory,
      mutate: async (directory) => {
        const path = join(directory, "tileset.json");
        const tileset = JSON.parse(await readFile(path, "utf8"));
        tileset.root.children[0].content.uri = "content/missing.glb";
        await writeJson(path, tileset);
      },
      expectedCode: "RESOURCE_MISSING",
    },
    {
      name: "producer-generated tileset has an invalid bounding volume",
      source: generated.explicitDirectory,
      mutate: async (directory) => {
        const path = join(directory, "tileset.json");
        const tileset = JSON.parse(await readFile(path, "utf8"));
        tileset.root.boundingVolume = { box: [0, 0, 0] };
        await writeJson(path, tileset);
      },
      expectedCode: "BOUNDING_VOLUME_VALUES",
    },
    {
      name: "producer-generated subtree is truncated",
      source: generated.implicitDirectory,
      mutate: async (directory) => {
        const path = join(directory, "subtrees/0/0/0/0.subtree");
        const bytes = await readFile(path);
        await writeFile(path, bytes.subarray(0, bytes.length - 1));
      },
      expectedCode: "SUBTREE_LENGTH",
    },
    {
      name: "producer-generated subtree has an invalid availability buffer view",
      source: generated.implicitDirectory,
      mutate: async (directory) => mutateSubtreeJson(
        join(directory, "subtrees/0/0/0/0.subtree"),
        (json) => { json.tileAvailability = { bitstream: 999 }; },
      ),
      expectedCode: "SUBTREE_BITSTREAM",
    },
  ];

  for (const [index, item] of negativeCases.entries()) {
    const destination = join(root, `negative-${index}`);
    await copyDirectory(item.source, destination);
    await item.mutate(destination);
    cases.push({ name: item.name, source: destination, expectedValid: false, expectedCode: item.expectedCode });
  }
  return cases;
}

function reportSummary(report) {
  return {
    valid: report.valid,
    conformance: report.conformance,
    issues: report.issues.map(({ code, severity }) => ({ code, severity })),
    stats: report.stats,
  };
}

test("published producer outputs validate through the public API and CLI", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "copc-real-producer-fixtures-"));
  try {
    const generated = await makeFixtures(temporaryRoot);
    const actualHashes = await generatedHashes(temporaryRoot, generated.artifactFiles);
    assert.deepEqual(actualHashes, expectedHashes.artifacts, "producer outputs differ from the pinned byte hashes");

    const cases = await makeCases(temporaryRoot, generated);
    const records = [];
    for (const fixtureCase of cases) {
      await t.test(fixtureCase.name, async () => {
        const apiReport = await validateTileset(fixtureCase.source);
        assert.equal(apiReport.valid, fixtureCase.expectedValid, "public API pass/fail outcome");
        assert.equal(apiReport.conformance, "partial");
        if (fixtureCase.expectedCode) {
          assert.ok(apiReport.issues.some((issue) => issue.code === fixtureCase.expectedCode && issue.severity === "ERROR"),
            `API report must contain ${fixtureCase.expectedCode} ERROR`);
        } else {
          assert.equal(apiReport.issues.some((issue) => issue.severity === "ERROR"), false);
          for (const code of fixtureCase.expectedWarnings ?? []) {
            assert.ok(apiReport.issues.some((issue) => issue.code === code && issue.severity === "WARNING"),
              `API report must contain ${code} WARNING`);
          }
          for (const [name, expected] of Object.entries(fixtureCase.expectedStats ?? {})) {
            assert.equal(apiReport.stats[name], expected, `API report ${name} statistic`);
          }
        }

        const cli = spawnSync(process.execPath, [cliPath, fixtureCase.source, "--json"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        assert.equal(cli.error, undefined, cli.error?.message);
        assert.equal(cli.status, fixtureCase.expectedValid ? 0 : 1, "CLI exit status");
        const cliReport = JSON.parse(cli.stdout);
        assert.equal(cliReport.valid, fixtureCase.expectedValid, "CLI pass/fail outcome");
        if (fixtureCase.expectedCode) {
          assert.ok(cliReport.issues.some((issue) => issue.code === fixtureCase.expectedCode && issue.severity === "ERROR"),
            `CLI report must contain ${fixtureCase.expectedCode} ERROR`);
        } else {
          assert.equal(cliReport.issues.some((issue) => issue.severity === "ERROR"), false);
          for (const code of fixtureCase.expectedWarnings ?? []) {
            assert.ok(cliReport.issues.some((issue) => issue.code === code && issue.severity === "WARNING"),
              `CLI report must contain ${code} WARNING`);
          }
          for (const [name, expected] of Object.entries(fixtureCase.expectedStats ?? {})) {
            assert.equal(cliReport.stats[name], expected, `CLI report ${name} statistic`);
          }
        }
        records.push({ name: fixtureCase.name, api: reportSummary(apiReport), cli: reportSummary(cliReport) });
      });
    }

    const summary = {
      producers: expectedHashes.producer,
      fixtureCaseCount: cases.length,
      validatorReports: records,
    };
    const serialized = JSON.stringify(summary);
    console.log(`PRODUCER_FIXTURE_SUMMARY ${serialized}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [
        "## Real producer fixture validation",
        "",
      `Producer packages: COPC Adapter ${expectedHashes.producer["@frillab/copc-adapter"].version} (${expectedHashes.producer["@frillab/copc-adapter"].integrity}), COPC Tiles ${expectedHashes.producer["@frillab/copc-tiles"].version} (${expectedHashes.producer["@frillab/copc-tiles"].integrity})`,
        `Fixture cases: ${cases.length}`,
        "",
        "| Fixture | API | CLI | Issues (code / severity) |",
        "| --- | --- | --- | --- |",
        ...records.map((record) => {
          const describe = (report) => report.valid ? "PASS" : "FAIL";
          const issues = record.api.issues.map((issue) => `${issue.code} / ${issue.severity}`).join(", ") || "none";
          return `| ${record.name} | ${describe(record.api)} | ${describe(record.cli)} | ${issues} |`;
        }),
        "",
      ];
      await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
