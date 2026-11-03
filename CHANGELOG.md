# Changelog

Notable changes to this project are recorded here. There are no published validator releases yet; the entries below describe the current unreleased development candidate.

## [Unreleased]

### Changed

- Repurposed the repository history of the former standalone 3D Tiles generator for the independent `copc-tiles-validate` project.

### Added

- Initial dependency-free Node.js library and CLI for partial structural validation of local 3D Tiles 1.0 and 1.1 tilesets.
- Checks for basic tileset and tile structure, bounding volumes, local resource references, GLB 2.0 containers, and root implicit subtree structure.
- Configurable limits for input sizes, resources, tile count, traversal depth, and issue reporting.
- Machine-readable checked, partial, and skipped coverage, with opt-in fail-on-unverified behavior in the API and CLI.
- Hardened GLB chunk ordering and buffer bounds, subtree JSON/binary buffer checks, tileset collections and extension declarations, affine transforms, and URI containment.
- Positive and negative regression coverage for supported validation behavior and unsafe or malformed inputs.

### Limitations

- Validation is structural and partial. It does not replace the CesiumGS 3D Tiles Validator or Khronos glTF Validator.
- Deep implicit subtree traversal, full glTF semantics, legacy tile content formats, remote resources, and 3TZ / `.3dtiles` archives are not fully checked or supported.
