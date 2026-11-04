# copc-tiles-validate

A lightweight, source-neutral **structural** validator for local 3D Tiles assets. It does not require COPC.

This repository's history includes the former standalone Tiles generator. The project is now maintained as `copc-tiles-validate`, an independent validator package.

> **Status:** Development candidate; not yet published to npm. This tool does **not** certify full 3D Tiles or glTF conformance. Use the official [CesiumGS 3D Tiles Validator](https://github.com/CesiumGS/3d-tiles-validator) and [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) for independent conformance checks.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Release checklist](RELEASE_CHECKLIST.md) · [License](LICENSE) · [Attribution](NOTICE.md) · [GitHub repository](https://github.com/FrilLab/copc-tiles-validate)

## Goals

- Validate general 3D Tiles without depending on a specific source or generator.
- Support Node.js 22.12 and later, with CI coverage for Node 22.12, 24, and 26.
- Use built-in Node.js modules only; no runtime dependencies or native add-ons.
- Return machine-readable diagnostics for CLI and library users.
- Bound resource reads and tile traversal, and keep local resource references inside the input directory.

## Install and run

The package has not been published to npm yet. From a checkout, run:

```bash
npm ci
npm run verify
node src/cli.js ./output/tileset.json --json
```

After publication, install and run the CLI with:

```bash
npm install @frillab/copc-tiles-validate
npx copc-tiles-validate ./output/tileset.json --json
```

The CLI accepts a `tileset.json` path or a directory containing it. Use `--no-content` to skip referenced-resource checks. By default it exits with **0** when no implemented check reports an error, **1** when errors are found, and **2** for invalid arguments or runtime argument failures. `--fail-on-unverified` also exits with **1** if any coverage is partial or skipped.

## Library API

```js
import { validateTileset } from "@frillab/copc-tiles-validate";

const report = await validateTileset("./output/tileset.json", {
  checkContent: true,
  maxTiles: 100000,
  maxDepth: 128,
  maxJsonBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxResources: 100000,
  maxIssues: 500,
  failOnUnverified: false,
});

console.log(report.valid, report.passed, report.coverage, report.issues);
```

The report contains `valid`, `passed`, `coverage`, `conformance: "partial"`, `issues` (`severity`, `code`, `path`, and `message`), and `stats`. `valid: true` keeps its existing meaning: the implemented structural checks found no errors. `passed` applies the selected policy and becomes false for partial or skipped coverage when `failOnUnverified: true`. Coverage lists checked, partial, and skipped areas with counts, reasons, and up to five example paths. A `complete` coverage status describes only the checks implemented by this package; it is not standards certification.

## Implemented checks

- Basic tileset and tile structure for 3D Tiles 1.0 and 1.1, including asset version, geometric error, bounding volumes, transforms, refine values, children, and content URI fields.
- Local resource references, including missing files, external tileset JSON, cycles, path traversal, and symlink escapes outside the input directory.
- GLB 2.0 container structure, JSON asset version, chunk order and bounds, embedded buffer length, and local external-buffer references. GLB content is also identified by magic when its URI has no `.glb` suffix.
- Implicit tiling configuration and URI templates; bounded traversal of reachable local subtrees, exact availability bitstream lengths and padding, available counts, parent/content relationships, and available content resources.
- Configurable limits for tile count, traversal depth, JSON size, resource count, file size, and diagnostic count.

## Known limitations

This package performs partial structural checks:

- It does not perform full glTF, accessor, mesh, extension, or metadata semantic validation.
- Implicit subtree and content traversal is limited by `maxDepth`, `maxTiles`, `maxResources`, and `maxFileBytes`. Availability bitstreams are checked structurally, but tile bounding volumes are not expanded and subtree metadata semantics are not validated.
- It does not parse 3TZ or `.3dtiles` package archives.
- Legacy B3DM, I3DM, PNTS, CMPT, standalone `.gltf`, and custom content formats are not fully checked; referenced files of these formats receive a warning.
- Remote, signed, query-bearing, and data URIs are not fetched.
- Referenced local resources must remain inside the initial tileset directory. Some otherwise valid deployment layouts may place resources elsewhere.
- Structural checks do not replace the official CesiumGS or Khronos validators.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, and review expectations. See [NOTICE.md](NOTICE.md) for attribution and provenance.

## Producer-generated fixture gate

The separate [`integration/producer-fixtures`](integration/producer-fixtures/README.md) job generates explicit and implicit 3D Tiles outputs through the pinned `@frillab/copc-tiles` producer APIs and Adapter Core's public point-preparation APIs. It checks byte hashes, validates every case through both the public API and CLI, and compares the same outputs with pinned CesiumGS and Khronos validators. The producer and official validator packages are test-only; they stay out of the published dependency graph and Node 22/24/26 validator matrix.

The fixture source is synthetic and implements Adapter Core's public source contract. It exercises the real Core coordinate preparation and Tiles generators without opening a COPC file, so it does not establish real-source CRS or content interoperability.

The separate producer gate also packs this validator, installs the tarball in a clean consumer, and validates the generated explicit and implicit outputs through its ESM API and npm CLI. The ordinary Node.js matrix runs the packed-consumer API, declaration, CLI, dependency-graph, and tarball-inventory checks without installing the producer or official validator packages.

To run the integration fixture and differential checks locally, use `npm ci` and `npm run test:conformance` from `integration/producer-fixtures`. The separate conformance job uses Node 22.17.0 because the official validator dependency graph has native and Node-version constraints. Use the generated report as evidence for a narrow conformance statement; this job does not establish full 3D Tiles or glTF conformance.
