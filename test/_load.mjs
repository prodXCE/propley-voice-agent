// Loads a source module the way the real build does (tsup/esbuild resolves extensionless imports such as
// "./shared/phonetic-name-match"), for tests of files Node's own TypeScript stripping can't load.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function load(entry) {
  const outfile = join(mkdtempSync(join(tmpdir(), "va-test-")), "bundle.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}
