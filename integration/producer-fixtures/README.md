# Real producer validator fixtures

This test-only package exercises the published COPC Tiles producer through its
public APIs and its `wrapCopcCoreNodeSource()` bridge. A deterministic source
implements Adapter Core's public `CopcConservativeNodeSource` contract and uses
Core's exported coordinate-plan and point-preparation functions. It supplies
three synthetic nodes (including a zero-point child); the producer creates the
explicit tileset, point-cloud GLBs, implicit tileset, and binary subtree. This
does not open a COPC file or claim real-source CRS coverage. The validator
runtime and the Node 22/24/26 CI matrix do not depend on these producer packages.

The package lock pins these packed npm artifacts and their integrity hashes:

- `@frillab/copc-adapter@0.7.1`
- `@frillab/copc-tiles@0.1.0`

`expected-sha256.json` records npm integrity values and SHA-256 hashes of the
producer-generated explicit JSON/GLBs and implicit JSON/GLB/subtree. Update
those values only after reviewing a deliberate producer change. Test output
records the producer versions and integrities, fixture case count, and each
public API/CLI validator report. On GitHub Actions, the same summary is added
to the job summary.

Run from this directory with `npm ci` followed by `npm test`. Generated files
are created under the operating system temporary directory and removed after
the test.
