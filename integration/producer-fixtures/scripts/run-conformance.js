import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const testFile = join(packageDirectory, "test/real-producer.test.js");
const child = spawnSync(process.execPath, ["--test", testFile], {
  cwd: packageDirectory,
  env: { ...process.env, RUN_OFFICIAL_CONFORMANCE: "1" },
  stdio: "inherit",
});

if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
