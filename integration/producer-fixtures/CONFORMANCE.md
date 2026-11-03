# Differential conformance checks

Run `npm ci` and `npm run test:conformance` from this directory. The command
uses exact package versions recorded in `package.json` and
`package-lock.json`, regenerates the explicit and implicit assets with the
pinned producer APIs, checks their existing SHA-256 baseline, and runs each
fixture through the local API/CLI, [CesiumGS 3D Tiles Validator](https://github.com/CesiumGS/3d-tiles-validator), and [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator). It writes a machine-readable `conformance-summary.json` (or to `CONFORMANCE_REPORT_PATH` when set). The CI job uploads that report.

The CI job runs on Node 22.17.0, outside the Node 22/24/26 validator matrix.
The locked Cesium package requires Node 22.17 or later, and the official 3D
Tiles validator dependency tree includes native `sharp`; this job installs its
platform package normally. Neither official validator is a dependency of the
published validator package.

## Coverage and comparison rules

The comparison uses accept/reject outcomes for rules that overlap and records
`unverified` when an official tool leaves a generated GLB unchecked. It does
not require issue identifiers, warning counts, or message text to match. The
report retains issue types/codes and severities for diagnosis.

| Rule area | Local validator coverage | Differential comparison |
| --- | --- | --- |
| Tileset JSON structure, bounding volumes, geometric errors, local resource references | Structural checks implemented by the local API | Compare local tileset accept/reject with CesiumGS accept/reject. |
| GLB container and embedded buffer bounds | GLB header, length, chunk layout, asset version, and buffer bounds | Compare local GLB-container accept/reject with Khronos accept/reject for generated GLBs. Khronos also checks glTF semantics, which the local validator reports as unverified. |
| Implicit tiling and subtree | Root implicit configuration, root subtree container/JSON, and selected availability structure; deeper traversal and full availability semantics remain partial | Record CesiumGS result against local result. Keep the local coverage state in the report so matching outcomes do not imply equivalent depth. |
| Unknown extensions or content formats | Unsupported semantics are warned or skipped and appear in coverage | Record both judgments and classify mismatches as an unsupported standard rule. Do not treat skipped local coverage as a completed check. |

## Fixture classes

- `valid-supported-assets`: pinned producer explicit tileset and its GLBs.
- `malformed-supported-structure`: generated GLB/tileset/subtree files mutated
  to violate a local structural rule.
- `unsupported-extension-or-format`: generated producer output with an
  extension whose semantics the local validator does not implement.
- `ambiguous-semantics`: producer-generated implicit output. The local
  validator intentionally reports partial subtree/content semantics while the
  official validator performs its broader validation.

The checked-in `conformance-baseline.json` records expected outcomes and the
expected classification for each comparison. A new tool version or producer
artifact requires review of the machine report and an explicit baseline update.
An official result is called `unverified` when it has no error but one or more
generated GLBs have no corresponding content-validation record; this keeps an
unrecognized file from being mistaken for a successful validation. In this
baseline, CesiumGS 0.6.1 does not emit a content-validation record for the
malformed-magic GLB, so the result is recorded as `unverified`.
For a disagreement, the comparison classification is one of:

- `validator-false-positive`: local rejects while the official validator accepts.
- `validator-false-negative`: local accepts while the official validator rejects.
- `unsupported-standard-rule`: disagreement is in a locally skipped or partial
  area.
- `official-tool-version-limitation`: an official validator cannot inspect the
  case or the pinned official tool fails during execution.

These fixture checks are a differential baseline, not proof of full standards
conformance. The synthetic producer source also does not establish coverage of
real COPC source files or CRS variations.
