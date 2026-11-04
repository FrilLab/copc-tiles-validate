# Release readiness checklist

This project publishes versioned 0.x structural validation releases. A new release is ready only
when every gate below has current evidence and a maintainer explicitly approves
the release. Passing these gates does not certify full 3D Tiles or glTF
conformance.

## Before proposing a release

- [ ] Confirm the public API, CLI behavior, supported structural checks, strict
  `--fail-on-unverified` option, and documented limitations in `README.md`.
- [ ] Update `CHANGELOG.md` with the user-visible changes and the intended
  version. Do not describe partial structural validation as official standards
  conformance.
- [ ] Run `npm run verify` and `npm run test:packed` on Node.js 22.12, 24, and
  26. The `validator` CI matrix is the recorded source for these results.
- [ ] Review the packed-consumer report: `npm pack --dry-run` inventory,
  isolated tarball installation, JavaScript ESM import, TypeScript declaration
  compilation, npm bin invocation, `--help`, `--json`, and exit statuses 1 and
  2 must pass. The installed production dependency graph must contain no
  runtime or native dependencies.
- [ ] Run the separate
  [`integration/producer-fixtures`](integration/producer-fixtures/README.md)
  job. It generates explicit and implicit tilesets with pinned public producer
  artifacts, validates the generated outputs through the packed tarball, and
  compares supported cases with the pinned CesiumGS 3D Tiles Validator and
  Khronos glTF Validator.
- [ ] Review the generated conformance report and
  [`integration/producer-fixtures/CONFORMANCE.md`](integration/producer-fixtures/CONFORMANCE.md).
  Resolve or explicitly document every known disagreement, unverified result,
  and limitation in the checklist, report, or README before making release
  claims.
- [ ] Carry forward the current documented exception: CesiumGS 3D Tiles
  Validator 0.6.1 does not emit a content-validation record for the generated
  malformed-magic GLB, so that case is `unverified`, not accepted. The producer
  source is synthetic and does not establish real COPC or CRS coverage; local
  glTF semantics also remain unverified.
- [ ] Confirm `package.json` name, version, Node engine, repository, homepage,
  and issue tracker URLs match this repository. The packed-consumer gate checks
  the URL fields and README repository link.
- [ ] Confirm the root `package-lock.json` is committed and in sync with
  `package.json`; the Node.js matrix must install it with `npm ci`.
- [ ] Confirm the tarball contains `README.md`, `LICENSE`, `NOTICE.md`,
  `CHANGELOG.md`, `CONTRIBUTING.md`, and `src/`, and contains no tests,
  integration fixtures, generated binary assets, archives, or `node_modules`.

## Version and release notes policy

- Keep the current work under `## [Unreleased]` in `CHANGELOG.md`. Before a
  release, move the included entries under a dated `## [x.y.z] - YYYY-MM-DD`
  heading and leave a fresh `Unreleased` section.
- This package has not reached 1.0.0. Use patch versions for compatible fixes
  and documentation changes, and minor versions for features or intentional
  breaking changes while the project remains in 0.x. Call out API, CLI, input
  coverage, and policy changes in the changelog. Reserve 1.0.0 for an
  explicitly reviewed stable public contract.
- After 1.0.0, follow Semantic Versioning: patch for compatible fixes, minor for
  compatible features, and major for incompatible public API, CLI, or package
  behavior changes.
- Keep the package name `@frillab/copc-tiles-validate` and repository links
  consistent across `package.json`, README, and release notes. The historical
  repository name and former generator must not be presented as the current
  product.
- A completed checklist is evidence for review, not permission to publish.
  Publishing, tagging, merging, and closing issues remain explicit maintainer
  actions.

## GitHub Release to npm Trusted Publishing

- [ ] Configure the package's npm Trusted Publisher: GitHub owner `FrilLab`, repo `copc-tiles-validate`, workflow filename `publish.yml`, enable `npm publish`, and leave the environment name empty. Do not store an npm publish token.
- [ ] Change the package version **and** root lockfile, finalize a dated changelog heading for the new version, and merge the release commit to `main`.
- [ ] Create `vX.Y.Z` tag on the merged commit and publish a non-prerelease GitHub Release. Every merge to main does **not** publish.
- [ ] Review the release workflow (fast checks, packed consumer, pinned producer conformance, tag-to-version, ancestry, and duplicate npm version check).
- [ ] Verify npm version, package installation, and updated README after publication. npm does not permit rewriting README bytes for an existing version.
