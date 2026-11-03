#!/usr/bin/env node
import { validateTileset } from "./index.js";

const help = [
  "copc-tiles-validate <path-to-tileset.json|directory> [--json] [--no-content]",
  "",
  "Structural-only validation for local 3D Tiles 1.0 / 1.1.",
  "Does not replace full CesiumGS / Khronos conformance validation.",
].join("\n");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(help);
} else {
  const positionals = args.filter((value) => !value.startsWith("-"));
  const flags = args.filter((value) => value.startsWith("-"));
  if (positionals.length !== 1 || flags.some((flag) => !["--json", "--no-content"].includes(flag))) {
    console.error(help);
    process.exitCode = 2;
  } else {
    try {
      const report = await validateTileset(positionals[0], {
        checkContent: !flags.includes("--no-content"),
      });
      if (flags.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const issue of report.issues) {
          console.log(issue.severity + " " + issue.code + " " + issue.path + ": " + issue.message);
        }
        console.log((report.valid ? "PASS" : "FAIL") +
          " (partial structural validation; " + report.stats.tiles + " tiles)");
      }
      if (!report.valid) process.exitCode = 1;
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 2;
    }
  }
}
