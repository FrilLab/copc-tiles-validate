# copc-tiles-validate

A lightweight, source-neutral **structural** validator for local 3D Tiles assets. It does not require COPC.

This repository's history includes the former standalone Tiles generator. The project is now maintained as `copc-tiles-validate`, an independent validator package.

> **Status:** Development candidate; not yet published to npm. This tool does **not** certify full 3D Tiles or glTF conformance. Use the official [CesiumGS 3D Tiles Validator](https://github.com/CesiumGS/3d-tiles-validator) and [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) for independent conformance checks.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE) · [Attribution](NOTICE.md) · [GitHub repository](https://github.com/FrilLab/copc-tiles-validate)

## Goals

- Validate general 3D Tiles without depending on a specific source or generator.
- Support Node.js 22.12 and later, with CI coverage for Node 22.12, 24, and 26.
- Use built-in Node.js modules only; no runtime dependencies or native add-ons.
- Return machine-readable diagnostics for CLI and library users.
- Bound resource reads and tile traversal, and keep local resource references inside the input directory.

## Install and run

The package has not been published to npm yet. From a checkout, run:

```bash
npm install
npm run verify
node src/cli.js ./output/tileset.json --json
```

After publication, install and run the CLI with:

```bash
npm install @frillab/copc-tiles-validate
npx copc-tiles-validate ./output/tileset.json --json
```

The CLI accepts a `tileset.json` path or a directory containing it. Use `--no-content` to skip referenced-resource checks. It exits with **0** when no implemented check reports an error, **1** when errors are found, and **2** for invalid arguments or runtime argument failures. Warnings do not change the exit code.

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
});

console.log(report.valid, report.conformance, report.issues);
```

The report contains `valid`, `conformance: "partial"`, `issues` (`severity`, `code`, `path`, and `message`), and `stats`. `valid: true` means only that the implemented checks found no errors; it is not standards certification.

## Implemented checks

- Basic tileset and tile structure for 3D Tiles 1.0 and 1.1, including asset version, geometric error, bounding volumes, transforms, refine values, children, and content URI fields.
- Local resource references, including missing files, external tileset JSON, cycles, path traversal, and symlink escapes outside the input directory.
- GLB 2.0 container structure, JSON asset version, chunk bounds, and embedded buffer length.
- Implicit tiling configuration and URI templates; structural checks of the root binary subtree and its JSON availability objects.
- Configurable limits for tile count, traversal depth, JSON size, resource count, file size, and diagnostic count.

## Known limitations

This package performs partial structural checks:

- It does not perform full glTF, accessor, mesh, extension, or metadata semantic validation.
- It checks only the root implicit subtree. It does not traverse deeper subtrees or fully verify availability bit counts and cross-subtree semantics.
- It does not parse 3TZ or `.3dtiles` package archives.
- Legacy B3DM, I3DM, PNTS, CMPT, standalone `.gltf`, and custom content formats are not fully checked; referenced files of these formats receive a warning.
- Remote, signed, query-bearing, and data URIs are not fetched.
- Referenced local resources must remain inside the initial tileset directory. Some otherwise valid deployment layouts may place resources elsewhere.
- Structural checks do not replace the official CesiumGS or Khronos validators.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, and review expectations. See [NOTICE.md](NOTICE.md) for attribution and provenance.
