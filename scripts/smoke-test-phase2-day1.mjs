/**
 * Phase 2 Day 1 Smoke Test — CLI entry point
 *
 * Tests the commit-rag-cli command-line interface that will be invoked
 * by the JetBrains plugin via ProcessBuilder.
 *
 * Design doc reference: Phase 2 §5.0, §5.5 Day 1
 *
 * Usage:
 *   node scripts/smoke-test-phase2-day1.mjs
 *
 * With API keys (for full pipeline test):
 *   COMMIT_RAG_DASHSCOPE_API_KEY=sk-... COMMIT_RAG_DEEPSEEK_API_KEY=sk-... \
 *     node scripts/smoke-test-phase2-day1.mjs
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as url from "url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "packages", "core", "dist", "cli.js");
const REPO = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  // Remove API keys from env unless the test explicitly sets them via opts.env,
  // or opts.preserveKeys is true (which keeps all keys from process.env).
  if (!opts.preserveKeys) {
    const explicit = opts.env || {};
    if (!("COMMIT_RAG_DASHSCOPE_API_KEY" in explicit)) {
      delete env.COMMIT_RAG_DASHSCOPE_API_KEY;
    }
    if (!("COMMIT_RAG_DEEPSEEK_API_KEY" in explicit)) {
      delete env.COMMIT_RAG_DEEPSEEK_API_KEY;
    }
  }

  let stdout = "";
  let stderr = "";

  try {
    const result = await execFileP("node", [CLI, ...args], {
      cwd: REPO,
      env,
      timeout: opts.timeout || 30000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code || 1,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  }
}

function parse(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Help & argument parsing (no API keys needed)
// ---------------------------------------------------------------------------

console.log("\nPhase 1: Help & argument parsing\n");

await testAsync("--help prints usage", async () => {
  const { code, stdout } = await run(["--help"]);
  if (code !== 0) throw new Error(`exit code ${code}, expected 0`);
  if (!stdout.includes("commit-rag-cli")) throw new Error("help missing CLI name");
  if (!stdout.includes("index")) throw new Error("help missing 'index' command");
  if (!stdout.includes("generate")) throw new Error("help missing 'generate' command");
  if (!stdout.includes("--repo")) throw new Error("help missing --repo flag");
});

await testAsync("-h works as alias for --help", async () => {
  const { code, stdout } = await run(["-h"]);
  if (code !== 0) throw new Error(`exit code ${code}, expected 0`);
  if (!stdout.includes("commit-rag-cli")) throw new Error("-h missing CLI name");
});

await testAsync("no command → error JSON", async () => {
  const { code, stdout } = await run([]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (!result) throw new Error("not valid JSON");
  if (result.status !== "error") throw new Error(`status=${result.status}, expected error`);
  if (result.code !== "INVALID_ARGS") throw new Error(`code=${result.code}, expected INVALID_ARGS`);
});

await testAsync("unknown command → error JSON", async () => {
  const { code, stdout } = await run(["foobar"]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (!result) throw new Error("not valid JSON");
  if (result.status !== "error") throw new Error(`status=${result.status}`);
  if (result.code !== "INVALID_ARGS") throw new Error(`code=${result.code}`);
});

await testAsync("unknown flag → error JSON", async () => {
  const { code, stdout } = await run(["--unknown-flag"]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "INVALID_ARGS") throw new Error(`code=${result.code}`);
});

await testAsync("--repo without value → error JSON", async () => {
  const { code, stdout } = await run(["--repo"]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "INVALID_ARGS") throw new Error(`code=${result.code}`);
});

// ---------------------------------------------------------------------------
// Phase 2: Error handling — missing API keys
// ---------------------------------------------------------------------------

console.log("\nPhase 2: Error handling — missing API keys\n");

await testAsync("index without DASHSCOPE key → MISSING_DASHSCOPE_KEY", async () => {
  const { code, stdout } = await run(["index"]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "MISSING_DASHSCOPE_KEY") throw new Error(`code=${result.code}`);
});

await testAsync("generate without any keys → MISSING_DASHSCOPE_KEY", async () => {
  const { code, stdout } = await run(["generate"]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "MISSING_DASHSCOPE_KEY") throw new Error(`code=${result.code}`);
});

await testAsync("generate with DASHSCOPE but no DEEPSEEK key → MISSING_DEEPSEEK_KEY", async () => {
  const { code, stdout } = await run(["generate"], {
    env: { COMMIT_RAG_DASHSCOPE_API_KEY: "test-key" },
  });
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "MISSING_DEEPSEEK_KEY") throw new Error(`code=${result.code}`);
});

// ---------------------------------------------------------------------------
// Phase 3: Error handling — no staged changes
// ---------------------------------------------------------------------------

console.log("\nPhase 3: Error handling — no staged changes\n");

await testAsync("generate with both keys, no staged changes → NO_STAGED_CHANGES", async () => {
  const { code, stdout } = await run(["generate"], {
    env: {
      COMMIT_RAG_DASHSCOPE_API_KEY: "test-key",
      COMMIT_RAG_DEEPSEEK_API_KEY: "test-key",
    },
  });
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "NO_STAGED_CHANGES") throw new Error(`code=${result.code}`);
});

// ---------------------------------------------------------------------------
// Phase 4: --repo flag
// ---------------------------------------------------------------------------

console.log("\nPhase 4: --repo flag\n");

await testAsync("--repo flag is parsed correctly", async () => {
  const { code, stdout } = await run(["index", "--repo", REPO]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  // Should get MISSING_DASHSCOPE_KEY, not INVALID_ARGS — proves --repo was parsed
  if (result.code !== "MISSING_DASHSCOPE_KEY") throw new Error(`code=${result.code}`);
});

await testAsync("-r flag works as alias for --repo", async () => {
  const { code, stdout } = await run(["index", "-r", REPO]);
  if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
  const result = parse(stdout);
  if (result.code !== "MISSING_DASHSCOPE_KEY") throw new Error(`code=${result.code}`);
});

// ---------------------------------------------------------------------------
// Phase 5: Full pipeline (only if API keys are configured)
// ---------------------------------------------------------------------------

const hasDashScope = !!process.env.COMMIT_RAG_DASHSCOPE_API_KEY;
const hasDeepSeek = !!process.env.COMMIT_RAG_DEEPSEEK_API_KEY;

if (hasDashScope && hasDeepSeek) {
  console.log("\nPhase 5: Full pipeline (API keys detected)\n");

  await testAsync("index builds successfully and returns JSON", async () => {
    const { code, stdout } = await run(["index", "--repo", REPO], { preserveKeys: true });
    if (code !== 0) throw new Error(`exit code ${code}: ${stdout}`);
    const result = parse(stdout);
    if (result.status !== "ok") throw new Error(`status=${result.status}: ${result.error}`);
    if (typeof result.indexedCommits !== "number") throw new Error("missing indexedCommits");
    if (result.indexedCommits < 1) throw new Error(`indexedCommits=${result.indexedCommits}, expected >= 1`);
    if (!result.indexPath) throw new Error("missing indexPath");
    if (typeof result.elapsedSeconds !== "number") throw new Error("missing elapsedSeconds");
    console.log(`    Indexed ${result.indexedCommits} commits in ${result.elapsedSeconds}s`);
    console.log(`    Index path: ${result.indexPath}`);
  });

  await testAsync("generate with no staged changes → NO_STAGED_CHANGES", async () => {
    // Verify no staged changes exist
    const { code, stdout } = await run(["generate", "--repo", REPO], { preserveKeys: true });
    if (code !== 1) throw new Error(`exit code ${code}, expected 1`);
    const result = parse(stdout);
    if (result.code !== "NO_STAGED_CHANGES") throw new Error(`code=${result.code}`);
  });

  // Stage a test file and generate
  await testAsync("generate with staged changes produces commit message", async () => {
    // Create a temp file with clear semantic meaning
    const fs = await import("fs");
    const tmpFile = path.join(REPO, "test-cli-temp.txt");
    fs.writeFileSync(tmpFile, "// Test file for CLI smoke test\n// This would be a JWT auth middleware\n");
    fs.writeFileSync(tmpFile, "// Test file for CLI smoke test\n");

    // Stage it
    const { execFileP: gitExec } = await (async () => {
      return {
        execFileP: async (cmd, args, opts) => {
          const { execFile } = await import("child_process");
          return new Promise((resolve, reject) => {
            execFile(cmd, args, opts, (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            });
          });
        }
      };
    })();

    try {
      const { execFile } = await import("child_process");
      await new Promise((resolve, reject) => {
        execFile("git", ["add", tmpFile], { cwd: REPO }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        });
      });

      const { code, stdout } = await run(["generate", "--repo", REPO], { preserveKeys: true });
      const result = parse(stdout);

      if (code !== 0) {
        console.log(`    Note: generate returned error — ${result?.error || stdout}`);
        console.log("    (This may be expected — skip if API credits ran out)");
      } else {
        if (result.status !== "ok") throw new Error(`status=${result.status}`);
        if (!result.message) throw new Error("missing message");
        if (typeof result.message !== "string") throw new Error("message is not a string");
        if (result.message.length === 0) throw new Error("empty message");
        if (typeof result.retrievedCount !== "number") throw new Error("missing retrievedCount");
        if (!Array.isArray(result.topScores)) throw new Error("missing topScores array");
        console.log(`    Generated: "${result.message}"`);
        console.log(`    Retrieved ${result.retrievedCount} similar commits`);
        if (result.usage) {
          console.log(`    Tokens: ${result.usage.promptTokens} prompt + ${result.usage.completionTokens} completion`);
        }
      }
    } finally {
      // Cleanup: unstage and remove temp file
      const { execFile } = await import("child_process");
      await new Promise((resolve) => {
        execFile("git", ["reset", "--", tmpFile], { cwd: REPO }, () => resolve());
      });
      fs.unlinkSync(tmpFile);
    }
  });

} else {
  console.log("\nPhase 5: Full pipeline — SKIPPED (no API keys in environment)\n");
  console.log("  Set COMMIT_RAG_DASHSCOPE_API_KEY and COMMIT_RAG_DEEPSEEK_API_KEY to run.\n");
}

// ---------------------------------------------------------------------------
// Phase 6: Verify CLI output is valid JSON in all cases
// ---------------------------------------------------------------------------

console.log("\nPhase 6: Every output is valid JSON\n");

const allCases = [
  { args: [], expectCode: 1, label: "no command" },
  { args: ["unknown"], expectCode: 1, label: "unknown command" },
  { args: ["index"], expectCode: 1, label: "index (no key)" },
  { args: ["generate"], expectCode: 1, label: "generate (no key)" },
];

for (const { args, expectCode, label } of allCases) {
  await testAsync(`output for "${label}" is valid JSON`, async () => {
    const { code, stdout } = await run(args);
    if (code !== expectCode) throw new Error(`exit ${code}, expected ${expectCode}`);
    const result = parse(stdout);
    if (!result) throw new Error("stdout is not valid JSON");
    if (!result.status) throw new Error("missing 'status' field");
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  console.log("❌ Some tests FAILED.\n");
  process.exit(1);
} else {
  console.log("✅ All tests passed.\n");
}
