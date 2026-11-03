# Agent Instructions — Lightweight 3D Tiles Validator

- This repository is being repurposed from \`copc-tiles\` to \`copc-tiles-validate\`.
- Mission: reusable, source-neutral, lightweight **structural** 3D Tiles validation. Do not import COPC Adapter, Cesium, the standalone Tiles generator, or native dependencies.
- Keep the API portable for Node 22, 24, and 26; use built-in Node modules.
- Maintain honest limitations: the checker is not equivalent to the official CesiumGS 3D Tiles Validator or Khronos glTF Validator.
- Validate malicious/invalid inputs without trusting URIs, binary lengths, unbounded trees, or links outside the input root.
- For borrowed Apache-2.0 code, preserve original copyright and license notices, mark modified files, and update NOTICE.md as applicable. Do not silently vendor upstream dependencies.
- Add negative regression tests for every new rule; minimize false positives on valid 3D Tiles 1.0 and 1.1.
- Keep GitHub issues, commits, PRs and code comments in English. README may be Korean.
- Do not merge, publish, release, rename the GitHub repository, or close historic Tiles issues without explicit maintainer approval.
- Keep this PR reviewable; distinguish passed tests from not-run tests.
