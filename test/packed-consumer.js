import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "copc-tiles-validate-packed-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function runNpm(args, options = {}) {
  return run(npmCommand, args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function assertSucceeded(result, description) {
  assert.equal(result.error, undefined, `${description}: ${result.error?.message ?? ""}`);
  assert.equal(result.status, 0, `${description}\n${result.stdout}\n${result.stderr}`);
}

async function filesUnder(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split("\\").join("/"));
  }
  return files;
}

function packedFiles(packResult) {
  assert.ok(Array.isArray(packResult) && packResult.length === 1, "npm pack must return one package record");
  return packResult[0].files.map(({ path }) => path).sort();
}

try {
  const sourceManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.equal(sourceManifest.name, "@frillab/copc-tiles-validate");
  assert.equal(sourceManifest.engines.node, ">=22.12.0");
  assert.equal(sourceManifest.repository.url, "git+https://github.com/FrilLab/copc-tiles-validate.git");
  assert.equal(sourceManifest.homepage, "https://github.com/FrilLab/copc-tiles-validate#readme");
  assert.equal(sourceManifest.bugs.url, "https://github.com/FrilLab/copc-tiles-validate/issues");
  assert.ok(readme.includes("https://github.com/FrilLab/copc-tiles-validate"),
    "README repository URL must match package metadata");
  for (const required of ["README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md", "CONTRIBUTING.md", "src/"]) {
    assert.ok(sourceManifest.files.includes(required), `package files must include ${required}`);
  }
  assert.equal(sourceManifest.dependencies, undefined, "package must not declare runtime dependencies");
  assert.equal(sourceManifest.optionalDependencies, undefined, "package must not declare optional runtime dependencies");
  assert.equal(sourceManifest.peerDependencies, undefined, "package must not declare peer runtime dependencies");
  assert.ok(sourceManifest.devDependencies?.typescript,
    "the declaration contract must have a development-only TypeScript compiler");

  const expectedInventory = ["package.json"];
  for (const entry of sourceManifest.files) {
    if (entry.endsWith("/")) {
      expectedInventory.push(...await filesUnder(join(repositoryRoot, entry.slice(0, -1)), repositoryRoot));
    } else {
      expectedInventory.push(entry);
    }
  }
  expectedInventory.sort();

  const dryRun = runNpm(["pack", "--dry-run", "--json"]);
  assertSucceeded(dryRun, "npm pack --dry-run --json");
  const dryRunResult = JSON.parse(dryRun.stdout);
  const dryRunInventory = packedFiles(dryRunResult);
  assert.deepEqual(dryRunInventory, expectedInventory,
    "dry-run package inventory must match the explicit distributable files");
  assert.ok(!dryRunInventory.some((path) =>
    path.startsWith("integration/") || path.startsWith("test/") || path.includes("node_modules/") ||
    /\.(?:glb|subtree|bin|tgz|node)$/.test(path)),
  "fixtures, generated binaries, archives, native add-ons, tests, and node_modules must be excluded");

  const archiveDirectory = join(temporaryRoot, "archive");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const sampleDirectory = join(consumerDirectory, "sample");
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(sampleDirectory, { recursive: true });
  const packed = runNpm(["pack", "--json", "--pack-destination", archiveDirectory]);
  assertSucceeded(packed, "npm pack");
  const packResult = JSON.parse(packed.stdout);
  assert.deepEqual(packedFiles(packResult), dryRunInventory,
    "the produced tarball inventory must match the dry-run inventory");
  const archivePath = join(archiveDirectory, packResult[0].filename);

  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({
    name: "copc-tiles-validate-packed-consumer",
    private: true,
    type: "module",
    dependencies: { [sourceManifest.name]: sourceManifest.version },
  }, null, 2));
  const install = runNpm([
    "install", "--prefix", consumerDirectory, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", archivePath,
  ]);
  assertSucceeded(install, "install packed tarball in clean consumer");

  const installedManifestPath = join(consumerDirectory, "node_modules", "@frillab", "copc-tiles-validate", "package.json");
  const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
  assert.equal(installedManifest.name, sourceManifest.name);
  assert.equal(installedManifest.version, sourceManifest.version);
  assert.equal(installedManifest.dependencies, undefined);
  assert.equal(installedManifest.optionalDependencies, undefined);
  assert.equal(installedManifest.peerDependencies, undefined);

  const dependencyTree = runNpm(["ls", "--json", "--all", "--omit=dev"], { cwd: consumerDirectory });
  assertSucceeded(dependencyTree, "inspect installed production dependency graph");
  const productionDependencies = JSON.parse(dependencyTree.stdout).dependencies ?? {};
  assert.deepEqual(Object.keys(productionDependencies), [sourceManifest.name],
    "the installed production graph must contain only the validator package");
  assert.deepEqual(productionDependencies[sourceManifest.name].dependencies ?? {}, {},
    "the validator must have no transitive production dependencies");

  const validTileset = {
    asset: { version: "1.1" },
    geometricError: 0,
    root: {
      boundingVolume: { sphere: [0, 0, 0, 1] },
      geometricError: 0,
      refine: "REPLACE",
    },
  };
  const invalidTileset = structuredClone(validTileset);
  invalidTileset.root.geometricError = -1;
  await writeFile(join(sampleDirectory, "valid.json"), JSON.stringify(validTileset));
  await writeFile(join(sampleDirectory, "invalid.json"), JSON.stringify(invalidTileset));

  const generatedRoot = process.env.PACKED_CONSUMER_FIXTURE_ROOT;
  const generatedDirectories = generatedRoot
    ? ["explicit", "implicit"].map((name) => join(generatedRoot, name))
    : [];
  for (const directory of generatedDirectories) {
    const stat = await readFile(join(directory, "tileset.json"), "utf8");
    assert.ok(JSON.parse(stat).root, `generated fixture at ${directory} must contain a tileset root`);
  }

  const apiScript = join(consumerDirectory, "api-contract.mjs");
  await writeFile(apiScript, `
import assert from "node:assert/strict";
import { validateTileset, validationLimits } from "@frillab/copc-tiles-validate";

const [validPath, invalidPath, ...generatedPaths] = process.argv.slice(2);
assert.ok(validationLimits.maxTiles > 0);
const valid = await validateTileset(validPath);
assert.equal(valid.valid, true);
assert.equal(valid.passed, true);
assert.equal(valid.conformance, "partial");
const invalid = await validateTileset(invalidPath);
assert.equal(invalid.valid, false);
assert.ok(invalid.issues.some((issue) => issue.severity === "ERROR"));
for (const path of generatedPaths) {
  const report = await validateTileset(path);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.ok(report.stats.glbs > 0, "generated producer fixture must include actual GLB content");
}
`);
  const sampleValidPath = join(sampleDirectory, "valid.json");
  const sampleInvalidPath = join(sampleDirectory, "invalid.json");
  const api = run(process.execPath, [apiScript, sampleValidPath, sampleInvalidPath, ...generatedDirectories], {
    cwd: consumerDirectory,
  });
  assertSucceeded(api, "JavaScript ESM API contract against installed tarball");

  const cliPath = join(consumerDirectory, "node_modules", ".bin", "copc-tiles-validate");
  const help = run(cliPath, ["--help"], { cwd: consumerDirectory });
  assertSucceeded(help, "installed npm bin --help");
  assert.ok(help.stdout.includes("copc-tiles-validate <path-to-tileset.json|directory>"));
  assert.ok(help.stdout.includes("Structural-only validation"));

  const validJson = run(cliPath, [sampleValidPath, "--json"], { cwd: consumerDirectory });
  assertSucceeded(validJson, "installed npm bin --json on valid input");
  assert.equal(JSON.parse(validJson.stdout).valid, true);
  for (const directory of generatedDirectories) {
    const result = run(cliPath, [directory, "--json"], { cwd: consumerDirectory });
    assertSucceeded(result, `installed npm bin --json on generated fixture ${directory}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.ok(report.stats.glbs > 0, "CLI must inspect producer-generated GLB content");
  }

  const invalidJson = run(cliPath, [sampleInvalidPath, "--json"], { cwd: consumerDirectory });
  assert.equal(invalidJson.error, undefined, invalidJson.error?.message);
  assert.equal(invalidJson.status, 1, "structural validation errors must exit with status 1");
  assert.equal(JSON.parse(invalidJson.stdout).valid, false);
  const invalidArguments = run(cliPath, ["--unknown-option"], { cwd: consumerDirectory });
  assert.equal(invalidArguments.error, undefined, invalidArguments.error?.message);
  assert.equal(invalidArguments.status, 2, "invalid CLI arguments must exit with status 2");

  if (process.env.PACKED_CONSUMER_SKIP_TYPES !== "1") {
    const typeScriptPath = process.env.TSC_BIN ?? join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    const typeContract = join(consumerDirectory, "api-contract.ts");
    await writeFile(typeContract, `
import { validateTileset, validationLimits, type ValidationReport } from "@frillab/copc-tiles-validate";

const reportPromise: Promise<ValidationReport> = validateTileset("./tileset.json", {
  checkContent: true,
  failOnUnverified: true,
});
const maxTiles: number = validationLimits.maxTiles;
void reportPromise.then((report) => {
  const valid: boolean = report.valid;
  const status: "partial" = report.conformance;
  const issueCode: string | undefined = report.issues[0]?.code;
  void [valid, status, issueCode, maxTiles];
});
`);
    const compiler = run(process.execPath, [
      typeScriptPath,
      "--noEmit",
      "--strict",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      typeContract,
    ], { cwd: consumerDirectory });
    assertSucceeded(compiler, "compile TypeScript against installed package declarations");
  }

  console.log(`PACKED_CONSUMER_PASS ${JSON.stringify({
    version: installedManifest.version,
    files: dryRunInventory.length,
    generatedProducerFixtures: generatedDirectories.length,
    typeDeclarations: process.env.PACKED_CONSUMER_SKIP_TYPES === "1" ? "not-run" : "compiled",
    productionDependencies: Object.keys(productionDependencies[sourceManifest.name].dependencies ?? {}).length,
  })}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
