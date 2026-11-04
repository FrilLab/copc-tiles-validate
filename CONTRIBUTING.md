# Contributing

Thanks for helping improve `copc-tiles-validate`. Keep changes focused on source-neutral, lightweight structural validation and preserve the package's honest limits: a passing report is not official 3D Tiles or glTF conformance certification.

## Prerequisites

- Node.js 22.12 or later.
- CI runs the verification and packed-package checks on Node 22.12, 24, and 26.
- npm, included with Node.js.

The package has no runtime dependencies and uses built-in Node.js modules.

## Set up and verify

From the repository root:

```bash
npm ci
npm run verify
npm run test:packed
```

`npm run verify` runs JavaScript syntax checks and the fast validator test suite. `npm run test:packed` checks the dry-run tarball inventory, installs the tarball into a temporary consumer, compiles a TypeScript consumer against its declarations, exercises the ESM API and npm CLI, and inspects the installed production dependency graph. The TypeScript compiler is a development-only dependency and is not shipped as a runtime dependency. CI runs both commands on Node 22.12, 24, and 26.

To smoke-check the CLI against a minimal valid tileset from the checkout:

```bash
smoke_dir=$(mktemp -d)
trap 'rm -rf "$smoke_dir"' EXIT
cat > "$smoke_dir/tileset.json" <<'JSON'
{
  "asset": { "version": "1.1" },
  "geometricError": 0,
  "root": {
    "boundingVolume": { "sphere": [0, 0, 0, 1] },
    "geometricError": 0
  }
}
JSON
node src/cli.js "$smoke_dir/tileset.json" --json
```

The packed-consumer command is the release gate for tarball installation and CLI behavior. It also checks generated producer outputs in the separate integration job. For the slower producer and official-validator comparison, run:

```bash
npm ci --prefix integration/producer-fixtures
npm run test:conformance --prefix integration/producer-fixtures
```

The producer and official validators run only in the isolated integration job, outside the ordinary Node.js matrix. Use Node 22.17.0 for this command, matching CI and the pinned validator dependency requirements.

## Validation changes and tests

- Add automated positive and negative regression cases for every new validation rule. Positive cases should cover valid 3D Tiles 1.0 and 1.1 inputs where the rule applies; negative cases should exercise malformed and unsafe inputs.
- Keep validator unit fixtures small and local. The default test suite must not fetch remote URIs or require COPC Adapter, Cesium, native modules, or external validator packages. The scoped issue #24 integration in `integration/producer-fixtures` is the exception: its separate locked package and CI job use pinned public producer artifacts to generate and validate synthetic fixtures. Do not add those packages to the root package or make the default test suite depend on them.
- Make each error explain the input problem and expected structure in its diagnostic message. Tests should assert the relevant issue code and the behavior that identifies the failure.
- Bound reads, parsing, and traversal. Treat URIs, binary lengths, tree depth, and filesystem links as untrusted input.
- Keep structural checks distinct from semantic validation and official conformance. Update the README's implemented checks and limitations when coverage changes.
- Run `npm run verify`, `npm pack --dry-run`, and the packed-consumer CLI smoke check when package contents or CLI behavior changes. Report which commands and Node versions were actually run; do not describe unrun checks as passed.

## Issues and pull requests

- Search existing issues before opening a new one. Include the Node.js version, a minimal input or reproduction, the observed diagnostic, and the expected behavior. Remove private or sensitive data from samples.
- For larger changes to the public API or validation scope, open an issue to discuss the approach before implementation.
- Keep pull requests focused. Link the related issue, summarize the behavior changed, explain any compatibility or security impact, and list the verification commands and Node versions run.
- Before proposing an npm release, work through [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) and include the producer fixture / official validator comparison results and any outstanding exceptions.
- Update user-facing documentation and the Unreleased section of `CHANGELOG.md` when behavior, supported input, CLI usage, or package contents change.
- Use English for issues, pull requests, commits, and code comments. Preserve Apache-2.0 attribution and update `NOTICE.md` if borrowed code is introduced.
- Do not publish a package, release, merge a pull request, rename the GitHub repository, or close historic issues as part of a contribution.
