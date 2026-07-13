/**
 * Bundle @commit-rag/core into the extension for packaging.
 *
 * vsce runs `npm list --production` which fails with pnpm workspace symlinks.
 * This esbuild step inlines everything from @commit-rag/core into a single
 * dist/extension.js so the .vsix has zero external workspace dependencies.
 *
 * The package.json "package" script handles backup/restore of the tsc output:
 *   1. esbuild overwrites dist/extension.js with the bundled version
 *   2. vsce packages it
 *   3. tsc restores the dev version (with workspace imports intact)
 */

import * as esbuild from "esbuild";
import { renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const entry = resolve(__dirname, "dist/extension.js");
const tmp = entry + ".esbuild-tmp";

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: tmp,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  keepNames: true,
});

// Atomic replace: esbuild won't overwrite its own input, so we do it manually
renameSync(tmp, entry);

console.log("[esbuild] Inlined @commit-rag/core → dist/extension.js");
