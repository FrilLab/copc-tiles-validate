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
npm install
npm run verify
npm pack --dry-run
```

`npm run verify` runs JavaScript syntax checks and the automated test suite. The CI workflow also packs the package and runs the installed CLI from a clean consumer directory on each supported Node.js line.

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

To smoke-check the packed CLI in an isolated consumer install:

```bash
smoke_dir=$(mktemp -d)
trap 'rm -rf "$smoke_dir"' EXIT
mkdir "$smoke_dir/consumer" "$smoke_dir/sample"
npm pack --pack-destination "$smoke_dir"
package_file=$(find "$smoke_dir" -maxdepth 1 -name 'frillab-copc-tiles-validate-*.tgz' -print -quit)
npm install --prefix "$smoke_dir/consumer" --no-audit --no-fund "$package_file"
cat > "$smoke_dir/sample/tileset.json" <<'JSON'
{
  "asset": { "version": "1.1" },
  "geometricError": 0,
  "root": {
    "boundingVolume": { "sphere": [0, 0, 0, 1] },
    "geometricError": 0
  }
}
JSON
"$smoke_dir/consumer/node_modules/.bin/copc-tiles-validate" "$smoke_dir/sample/tileset.json" --json
```

These shell examples use POSIX utilities and work in macOS and Linux shells. The CI workflow is the source of truth for the Node.js version matrix.

## Validation changes and tests

- Add automated positive and negative regression cases for every new validation rule. Positive cases should cover valid 3D Tiles 1.0 and 1.1 inputs where the rule applies; negative cases should exercise malformed and unsafe inputs.
- Keep fixtures small and local. Do not make tests fetch remote URIs or require COPC Adapter, Cesium, native modules, or external validator packages.
- Make each error explain the input problem and expected structure in its diagnostic message. Tests should assert the relevant issue code and the behavior that identifies the failure.
- Bound reads, parsing, and traversal. Treat URIs, binary lengths, tree depth, and filesystem links as untrusted input.
- Keep structural checks distinct from semantic validation and official conformance. Update the README's implemented checks and limitations when coverage changes.
- Run `npm run verify`, `npm pack --dry-run`, and the packed-consumer CLI smoke check when package contents or CLI behavior changes. Report which commands and Node versions were actually run; do not describe unrun checks as passed.

## Issues and pull requests

- Search existing issues before opening a new one. Include the Node.js version, a minimal input or reproduction, the observed diagnostic, and the expected behavior. Remove private or sensitive data from samples.
- For larger changes to the public API or validation scope, open an issue to discuss the approach before implementation.
- Keep pull requests focused. Link the related issue, summarize the behavior changed, explain any compatibility or security impact, and list the verification commands and Node versions run.
- Update user-facing documentation and the Unreleased section of `CHANGELOG.md` when behavior, supported input, CLI usage, or package contents change.
- Use English for issues, pull requests, commits, and code comments. Preserve Apache-2.0 attribution and update `NOTICE.md` if borrowed code is introduced.
- Do not publish a package, release, merge a pull request, rename the GitHub repository, or close historic issues as part of a contribution.
