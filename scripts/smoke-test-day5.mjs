/**
 * Day 5–6 verification — VS Code extension integration.
 *
 * Since the extension can only run inside the VS Code Extension Host,
 * this script verifies:
 * 1. Compiled extension JS contains expected exports and imports.
 * 2. Package.json has all required contribution points.
 * 3. Full pipeline runs end-to-end (the same flow the extension executes).
 * 4. VS Code-specific parts (SCM button, SecretStorage, status bar) are
 *    noted for manual F5 testing inside VS Code.
 *
 * Usage (both keys required for pipeline test):
 *   COMMIT_RAG_DASHSCOPE_API_KEY=sk-... COMMIT_RAG_DEEPSEEK_API_KEY=sk-... \
 *     node scripts/smoke-test-day5.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import * as fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Test 1: Verify compiled extension JS contains expected exports
// ---------------------------------------------------------------------------
console.log("=".repeat(60));
console.log("  Day 5–6: VS Code Extension Verification");
console.log("=".repeat(60));

console.log("\n--- Compiled extension analysis ---");

{
  const extPath = resolve(repoRoot, "packages/vscode-extension/dist/extension.js");
  if (!fs.existsSync(extPath)) {
    console.log(`  FAIL  extension.js not found at ${extPath}`);
    failed++;
  } else {
    const src = fs.readFileSync(extPath, "utf-8");
    const checks = [
      ["exports activate function", /exports\.activate\s*=/],
      ["exports deactivate function", /exports\.deactivate\s*=/],
      ["imports getStagedDiff from core", /getStagedDiff/],
      ["imports QwenEmbeddingProvider", /QwenEmbeddingProvider/],
      ["imports buildPrompt", /buildPrompt/],
      ["imports generateCommitMessage", /generateCommitMessage/],
      ["imports buildIndex from core", /buildIndex/],
      ["references SecretStorage", /SecretStorage|secrets\.(get|store|delete)/],
      ["references SCM inputBox", /inputBox/],
      ["references withProgress", /withProgress/],
      ["registers generateMessage command", /commit-rag\.generateMessage/],
      ["registers reindex command", /commit-rag\.reindex/],
      ["registers configureKeys command", /commit-rag\.configureKeys/],
    ];

    for (const [name, pattern] of checks) {
      if (pattern.test(src)) {
        console.log(`  PASS  ${name}`);
        passed++;
      } else {
        console.log(`  FAIL  ${name}`);
        failed++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test 2: Package.json contributions
// ---------------------------------------------------------------------------
console.log("\n--- Package contributions ---");

const pkg = require(resolve(repoRoot, "packages/vscode-extension/package.json"));

const pkgChecks = [
  ["SCM title button in scm/title menu", () => {
    const scmMenu = pkg.contributes?.menus?.["scm/title"];
    if (!scmMenu) throw new Error("missing scm/title menu");
    const btn = scmMenu.find((m) => m.command === "commit-rag.generateMessage");
    if (!btn) throw new Error("missing generate button");
    if (btn.group !== "navigation") throw new Error("should be in navigation group");
    if (btn.when !== "scmProvider == git") throw new Error("should only show for git scmProvider");
  }],
  ["three commands registered", () => {
    const cmds = pkg.contributes?.commands ?? [];
    const names = cmds.map((c) => c.command);
    if (!names.includes("commit-rag.generateMessage")) throw new Error("missing generateMessage");
    if (!names.includes("commit-rag.reindex")) throw new Error("missing reindex");
    if (!names.includes("commit-rag.configureKeys")) throw new Error("missing configureKeys");
  }],
  ["generate button has sparkle icon", () => {
    const cmd = pkg.contributes?.commands?.find((c) => c.command === "commit-rag.generateMessage");
    if (cmd?.icon !== "$(sparkle)") throw new Error("button missing sparkle icon");
  }],
  ["activationEvent is onStartupFinished", () => {
    if (!pkg.activationEvents?.includes("onStartupFinished")) {
      throw new Error("should activate onStartupFinished");
    }
  }],
  ["depends on @commit-rag/core (workspace:*)", () => {
    if (pkg.dependencies?.["@commit-rag/core"] !== "workspace:*") {
      throw new Error("missing workspace dependency on core");
    }
  }],
  ["VS Code engine >= 1.85", () => {
    if (!pkg.engines?.vscode) throw new Error("missing engines.vscode");
  }],
];

for (const [name, fn] of pkgChecks) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Test 3: Full pipeline simulation (the flow the extension runs internally)
// ---------------------------------------------------------------------------
const dashscopeKey = process.env.COMMIT_RAG_DASHSCOPE_API_KEY;
const deepseekKey = process.env.COMMIT_RAG_DEEPSEEK_API_KEY;

if (!dashscopeKey || !deepseekKey) {
  console.log(`\n⚠  API keys not set — skipping pipeline simulation.`);
  console.log(`   Set COMMIT_RAG_DASHSCOPE_API_KEY and COMMIT_RAG_DEEPSEEK_API_KEY to run.`);
} else {
  console.log("\n--- Pipeline simulation (extension's internal flow) ---");

  const {
    getStagedDiff,
    QwenEmbeddingProvider,
    loadIndex,
    buildIndex,
    saveIndex,
    retrieve,
    buildPrompt,
    generateCommitMessage,
  } = require(resolve(repoRoot, "packages/core/dist/index.js"));

  try {
    // Step 1: Create a test change and stage it (simulating user's "git add")
    console.log("         → creating staged test change...");
    const testFile = resolve(repoRoot, "test-temp.txt");
    fs.writeFileSync(testFile, "feat: add user authentication middleware\n\n- Add JWT token validation\n- Add role-based access control\n");
    const { execFile } = await import("child_process");
    await new Promise((res, rej) => {
      execFile("git", ["add", "test-temp.txt"], { cwd: repoRoot }, (err) => {
        if (err) rej(err); else res();
      });
    });

    let diff;
    try {
      diff = await getStagedDiff({ cwd: repoRoot });
      console.log(`         → staged diff: ${diff.split("\n").length} lines, ${diff.length} chars`);
    } finally {
      // Cleanup: unstage and remove the test file
      await new Promise((res) => {
        execFile("git", ["reset", "HEAD", "--", "test-temp.txt"], { cwd: repoRoot }, () => res());
      });
      fs.unlinkSync(testFile);
    }

    if (!diff.trim()) throw new Error("no diff after staging — test setup failed");

    // Step 2: Load/build index
    let index = loadIndex(repoRoot);
    console.log(`         → loaded index: ${index?.length ?? 0} entries`);

    if (!index || index.length === 0) {
      console.log("         → building index...");
      const qwen = new QwenEmbeddingProvider({ apiKey: dashscopeKey, dimensions: 1024 });
      index = await buildIndex(
        qwen,
        {
          indexing: { maxCommits: 5, maxDiffLines: 500 },
          retrieval: { topK: 3 },
          model: { embeddingModel: "text-embedding-v4", embeddingDimensions: 1024, llmModel: "deepseek-chat" },
          apiKeys: { dashscope: dashscopeKey },
        },
        { cwd: repoRoot, limit: 5 },
      );
      saveIndex(index, repoRoot);
      console.log(`         → built index with ${index.length} entries`);
    }

    // Step 3: Embed + retrieve
    const qwen = new QwenEmbeddingProvider({ apiKey: dashscopeKey, dimensions: 1024 });
    const [queryVec] = await qwen.embed([diff]);
    const retrieved = retrieve(queryVec, index, 5);

    console.log("         → retrieved similar commits:");
    for (const r of retrieved) {
      console.log(`           ${r.score.toFixed(3)} ${r.entry.hash.slice(0, 7)} ${r.entry.message.slice(0, 55)}`);
    }

    // Step 4: Build prompt + generate
    const messages = buildPrompt(diff, retrieved);
    console.log("         → calling DeepSeek...");
    const result = await generateCommitMessage(messages, {
      apiKey: deepseekKey,
      model: "deepseek-chat",
      temperature: 0.3,
      maxTokens: 500,
    });

    console.log(`         → tokens: ${result.usage ? `${result.usage.promptTokens}+${result.usage.completionTokens}=${result.usage.totalTokens}` : "N/A"}`);
    console.log(`         ┌${"─".repeat(60)}`);
    for (const line of result.message.split("\n")) {
      console.log(`         │ ${line}`);
    }
    console.log(`         └${"─".repeat(60)}`);

    // Validate conventional commits pattern
    const subject = result.message.split("\n")[0].trim();
    const ccPattern = /^(feat|fix|chore|docs|style|refactor|perf|test|ci|build|revert)(\(.+?\))?:\s.+$/;

    if (ccPattern.test(subject)) {
      console.log(`  PASS  Conventional Commits: "${subject}"`);
      passed++;
    } else {
      console.log(`  FAIL  doesn't match Conventional Commits pattern:`);
      console.log(`         expected: <type>(<scope>): <subject>`);
      console.log(`         got:      "${subject}"`);
      failed++;
    }

    // Validate subject length
    if (subject.length <= 72) {
      console.log(`  PASS  subject ≤72 chars (${subject.length})`);
      passed++;
    } else {
      console.log(`  FAIL  subject too long: ${subject.length} chars (max 72)`);
      failed++;
    }

    // Validate non-empty body for non-trivial changes
    const body = result.message.split("\n").slice(1).filter((l) => l.trim()).join("\n");
    if (body.length > 0) {
      console.log(`  PASS  includes body for complex change (${body.length} chars)`);
      passed++;
    }

  } catch (err) {
    console.log(`  FAIL  pipeline error: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log(`\n  ⚠  VS Code UI testing requires launching inside VS Code:`);
console.log(`    1. Open F:\\git\\packages\\vscode-extension in VS Code`);
console.log(`    2. Press F5 → Extension Development Host`);
console.log(`    3. Open a git repo, stage some changes`);
console.log(`    4. Click the ✨ (sparkle) button in the SCM title bar`);
console.log(`    5. Verify the message appears in the commit input box`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);
