/**
 * Day 1 smoke test — verifies the git interface layer works end-to-end.
 *
 * Run from the repo root:
 *   node scripts/smoke-test.mjs
 *
 * Uses the built core package directly (CommonJS require via dist/).
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const { getStagedDiff, getCommitHistory, getCommitDiff } = require(
  resolve(repoRoot, "packages/core/dist/index.js"),
);

async function main() {
  let passed = 0;
  let failed = 0;

  function check(name, fn) {
    return fn()
      .then(() => {
        console.log(`  PASS  ${name}`);
        passed++;
      })
      .catch((err) => {
        console.log(`  FAIL  ${name}: ${err.message}`);
        failed++;
      });
  }

  // ------------------------------------------------------------------
  // Test 1: getCommitHistory — should return at least 1 commit
  // ------------------------------------------------------------------
  await check("getCommitHistory() returns commits", async () => {
    const history = await getCommitHistory(10, { cwd: repoRoot });
    if (!Array.isArray(history)) throw new Error("expected an array");
    if (history.length === 0) throw new Error("expected at least 1 commit");
    const first = history[0];
    if (!first.hash || first.hash.length !== 40)
      throw new Error(`bad hash: ${first.hash}`);
    if (!first.message) throw new Error("missing message");
    console.log(
      `         → latest commit: ${first.hash.slice(0, 7)} ${first.message}`,
    );
  });

  // ------------------------------------------------------------------
  // Test 2: getCommitHistory with limit
  // ------------------------------------------------------------------
  await check("getCommitHistory(1) returns exactly 1 commit", async () => {
    const history = await getCommitHistory(1, { cwd: repoRoot });
    if (history.length !== 1)
      throw new Error(`expected 1, got ${history.length}`);
  });

  // ------------------------------------------------------------------
  // Test 3: getCommitDiff — should return the diff for a known commit
  // ------------------------------------------------------------------
  await check("getCommitDiff() returns diff for known commit", async () => {
    const history = await getCommitHistory(1, { cwd: repoRoot });
    const diff = await getCommitDiff(history[0].hash, { cwd: repoRoot });
    if (typeof diff !== "string" || diff.length === 0) {
      throw new Error("expected non-empty diff string");
    }
    console.log(`         → diff is ${diff.length} chars, starts with:`);
    console.log(`           ${diff.split("\n")[0]}`);
  });

  // ------------------------------------------------------------------
  // Test 4: getCommitDiff with invalid hash should throw
  // ------------------------------------------------------------------
  await check("getCommitDiff() rejects invalid hash", async () => {
    try {
      await getCommitDiff("xyz1234", { cwd: repoRoot });
      throw new Error("expected an error but got none");
    } catch (err) {
      if (!err.message.includes("Invalid commit hash")) {
        throw new Error(`unexpected error: ${err.message}`);
      }
    }
  });

  // ------------------------------------------------------------------
  // Test 5: getStagedDiff — should return empty when nothing staged
  // ------------------------------------------------------------------
  await check("getStagedDiff() returns empty when nothing staged", async () => {
    const diff = await getStagedDiff({ cwd: repoRoot });
    if (diff !== "")
      throw new Error(`expected empty string, got ${diff.length} chars`);
  });

  // ------------------------------------------------------------------
  // Test 6: getStagedDiff — should return non-empty when something IS staged
  // ------------------------------------------------------------------
  await check("getStagedDiff() returns diff after git add", async () => {
    const { execFile } = await import("child_process");
    const fs = await import("fs");

    const testFile = resolve(repoRoot, "test-staged.txt");
    fs.writeFileSync(testFile, "hello staged diff test\n");

    await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        "git",
        ["add", "test-staged.txt"],
        { cwd: repoRoot },
        (err) => {
          if (err) rejectPromise(err);
          else resolvePromise();
        },
      );
    });

    try {
      const diff = await getStagedDiff({ cwd: repoRoot });
      if (diff === "") throw new Error("expected non-empty diff after staging");
      console.log(`         → staged diff has ${diff.split("\n").length} lines`);
    } finally {
      // Clean up: unstage and remove the temp file
      await new Promise((resolvePromise) => {
        execFile(
          "git",
          ["reset", "HEAD", "--", "test-staged.txt"],
          { cwd: repoRoot },
          () => resolvePromise(),
        );
      });
      fs.unlinkSync(testFile);
    }
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log(
    `\n${passed} passed, ${failed} failed out of ${passed + failed} tests`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
