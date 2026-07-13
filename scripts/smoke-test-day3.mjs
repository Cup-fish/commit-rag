/**
 * Day 3 smoke test — validates prompt construction templates.
 *
 * Tests system prompt content, few-shot formatting, cold-start fallback,
 * diff truncation, example limits, and token estimation.
 *
 * Usage:
 *   node scripts/smoke-test-day3.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const {
  buildPrompt,
  estimateTokens,
  estimateMessageTokens,
} = require(resolve(repoRoot, "packages/core/dist/index.js"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, fn) {
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
// Test data
// ---------------------------------------------------------------------------

const SAMPLE_DIFF = `diff --git a/src/git.ts b/src/git.ts
index abc1234..def5678 100644
--- a/src/git.ts
+++ b/src/git.ts
@@ -10,6 +10,9 @@
 import { execFile } from "child_process";
+/**
+ * New documentation block.
+ */
 export function getStagedDiff(): Promise<string> {
   return execGit(["diff", "--cached", "--unified=3"]);
 }`;

const SAMPLE_RETRIEVED = [
  {
    entry: {
      hash: "abc1234def5678abc1234def5678abc1234d",
      message: "feat(git): add getStagedDiff function",
      diffSummary: "diff --git a/src/git.ts b/src/git.ts\n...\n+export function getStagedDiff()...",
      vector: new Array(1024).fill(0.01),
    },
    score: 0.92,
  },
  {
    entry: {
      hash: "fedcba9876543210fedcba9876543210fedcba9",
      message: "fix: handle empty staging area gracefully",
      diffSummary: "diff --git a/src/git.ts b/src/git.ts\n...\n-if (!diff) throw Error...\n+if (!diff) return ''...",
      vector: new Array(1024).fill(0.02),
    },
    score: 0.85,
  },
  {
    entry: {
      hash: "1111111111111111111111111111111111111111",
      message: "chore: add unit tests for git module",
      diffSummary: "diff --git a/test/git.test.ts b/test/git.test.ts\n...(new file)...\n+describe('getStagedDiff')...",
      vector: new Array(1024).fill(0.03),
    },
    score: 0.78,
  },
  {
    entry: {
      hash: "2222222222222222222222222222222222222222",
      message: "docs: update README with API examples",
      diffSummary: "diff --git a/README.md b/README.md\n...\n+## API Reference...",
      vector: new Array(1024).fill(0.04),
    },
    score: 0.65,
  },
  {
    entry: {
      hash: "3333333333333333333333333333333333333333",
      message: "refactor: extract execGit helper",
      diffSummary: "diff --git a/src/git.ts b/src/git.ts\n...\n-function execGit...",
      vector: new Array(1024).fill(0.05),
    },
    score: 0.61,
  },
  {
    entry: {
      hash: "4444444444444444444444444444444444444444",
      message: "style: format with prettier",
      diffSummary: "diff --git a/src/git.ts b/src/git.ts\n...\n-  return    execGit...",
      vector: new Array(1024).fill(0.06),
    },
    score: 0.55,
  },
];

const LARGE_DIFF = Array(500)
  .fill(0)
  .map((_, i) => `diff --git a/file${i}.ts b/file${i}.ts\n--- a/file${i}.ts\n+++ b/file${i}.ts\n@@ -1 +1 @@\n-old line\n+new line ${i}`)
  .join("\n");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

console.log("=".repeat(60));
console.log("  Day 3: Prompt Construction — Unit Tests");
console.log("=".repeat(60));

// -------------------------------------------------------------------
// 1. System prompt content
// -------------------------------------------------------------------
console.log("\n--- System prompt checks ---");

check("system prompt includes Conventional Commits format", () => {
  const messages = buildPrompt(SAMPLE_DIFF, []);
  const sys = messages[0].content;
  if (!sys.includes("Conventional Commits")) {
    throw new Error("missing 'Conventional Commits'");
  }
  if (!sys.includes("<type>") || !sys.includes("<subject>")) {
    throw new Error("missing format specification");
  }
});

check("system prompt instructs model to learn from examples", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED.slice(0, 1));
  const sys = messages[0].content;
  if (!sys.includes("Copy the conventions")) {
    throw new Error("missing example-learning instruction");
  }
  if (!sys.includes("Do NOT apply your own generic knowledge")) {
    throw new Error("missing project-specific override instruction");
  }
});

check("system prompt includes formatting rules", () => {
  const messages = buildPrompt(SAMPLE_DIFF, []);
  const sys = messages[0].content;
  if (!sys.includes("≤72") && !sys.includes("72 characters")) {
    throw new Error("missing subject length constraint");
  }
  if (!sys.includes("imperative")) {
    throw new Error("missing imperative mood requirement");
  }
  if (!sys.includes("no trailing period")) {
    throw new Error("missing period constraint");
  }
});

// -------------------------------------------------------------------
// 2. Normal flow: with few-shot examples
// -------------------------------------------------------------------
console.log("\n--- Few-shot formatting ---");

check("includes examples in user message", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED.slice(0, 2));
  const user = messages[1].content;
  if (!user.includes("Historical commits")) {
    throw new Error("missing 'Historical commits' header");
  }
  if (!user.includes("Example 1")) {
    throw new Error("missing Example 1");
  }
  if (!user.includes("Example 2")) {
    throw new Error("missing Example 2");
  }
});

check("each example shows hash, message, and diff", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED.slice(0, 1));
  const user = messages[1].content;
  if (!user.includes("abc1234")) throw new Error("missing hash");
  if (!user.includes("feat(git): add getStagedDiff")) throw new Error("missing message");
  if (!user.includes("<diff>")) throw new Error("missing diff block");
});

check("examples show similarity scores", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED.slice(0, 1));
  const user = messages[1].content;
  if (!user.includes("0.92")) throw new Error("missing similarity score");
});

check("default max examples = 5", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED); // 6 examples
  const user = messages[1].content;
  // Should only include 5, not the 6th
  if (user.includes("4444444")) throw new Error("6th example should not appear");
  if (!user.includes("3333333")) throw new Error("5th example should appear");
});

check("maxExamples option is respected", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED, { maxExamples: 2 });
  const user = messages[1].content;
  if (user.includes("Example 3")) throw new Error("should only have 2 examples");
  if (!user.includes("Example 2")) throw new Error("should include Example 2");
});

// -------------------------------------------------------------------
// 3. Cold start: no examples
// -------------------------------------------------------------------
console.log("\n--- Cold-start fallback ---");

check("empty retrieved array → cold-start message", () => {
  const messages = buildPrompt(SAMPLE_DIFF, []);
  const user = messages[1].content;
  if (!user.includes("no historical commit examples")) {
    throw new Error("missing cold-start note");
  }
  if (!user.includes("standard Conventional Commits")) {
    throw new Error("missing fallback instruction");
  }
  if (user.includes("Example 1")) {
    throw new Error("should not have examples section");
  }
});

check("cold-start suggests common types", () => {
  const messages = buildPrompt(SAMPLE_DIFF, []);
  const user = messages[1].content;
  if (!user.includes("feat, fix, chore")) {
    throw new Error("missing common type suggestions");
  }
});

// -------------------------------------------------------------------
// 4. Diff truncation
// -------------------------------------------------------------------
console.log("\n--- Diff truncation ---");

check("short diff is included verbatim", () => {
  const messages = buildPrompt(SAMPLE_DIFF, [], { maxCurrentDiffLines: 500 });
  const user = messages[1].content;
  if (!user.includes("New documentation block")) {
    throw new Error("short diff content should appear verbatim");
  }
});

check("large diff is truncated with summary", () => {
  const messages = buildPrompt(LARGE_DIFF, [], { maxCurrentDiffLines: 50 });
  const user = messages[1].content;
  if (!user.includes("[Diff truncated")) {
    throw new Error("missing truncation notice");
  }
  if (!user.includes("Changed files")) {
    throw new Error("missing file summary section");
  }
  // The file-list summary SHOULD list all changed files — that's the point.
  // The diff *content* section should be limited.
  const contentSection = user.split("## Diff (first portion)")[1] || "";
  const contentFileRefs = (contentSection.match(/file\d+\.ts/g) || []).length;
  if (contentFileRefs > 50) {
    throw new Error(
      `diff content section has ${contentFileRefs} file refs — should be limited`,
    );
  }
  console.log(`         → summary lists files, content limited to ~${contentFileRefs} file refs`);
});

check("empty diff → placeholder message", () => {
  const messages = buildPrompt("   \n  ", []);
  const user = messages[1].content;
  if (!user.includes("no staged changes")) {
    throw new Error("missing empty-staging-area note");
  }
});

// -------------------------------------------------------------------
// 5. Example diff truncation
// -------------------------------------------------------------------
console.log("\n--- Example diff truncation ---");

check("long example diff is truncated", () => {
  const longDiff = "x".repeat(3000);
  const retrieved = [{
    entry: { hash: "a".repeat(40), message: "test", diffSummary: longDiff, vector: [] },
    score: 0.9,
  }];
  const messages = buildPrompt(SAMPLE_DIFF, retrieved, { maxExampleDiffChars: 500 });
  const user = messages[1].content;
  if (user.includes("x".repeat(501))) {
    throw new Error("example diff should be truncated to ≤500 chars");
  }
  if (!user.includes("[truncated")) {
    throw new Error("missing truncation marker in example");
  }
});

// -------------------------------------------------------------------
// 6. Output structure
// -------------------------------------------------------------------
console.log("\n--- Output structure ---");

check("always returns exactly 2 messages", () => {
  const messages1 = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED);
  if (messages1.length !== 2) throw new Error(`expected 2, got ${messages1.length}`);

  const messages2 = buildPrompt("", []);
  if (messages2.length !== 2) throw new Error(`expected 2 for cold-start, got ${messages2.length}`);
});

check("first message is always system", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED);
  if (messages[0].role !== "system") throw new Error(`expected system, got ${messages[0].role}`);
});

check("second message is always user", () => {
  const messages = buildPrompt(SAMPLE_DIFF, SAMPLE_RETRIEVED);
  if (messages[1].role !== "user") throw new Error(`expected user, got ${messages[1].role}`);
});

check("user message contains current diff section", () => {
  const messages = buildPrompt(SAMPLE_DIFF, []);
  const user = messages[1].content;
  if (!user.includes("Current staged changes")) {
    throw new Error("missing 'Current staged changes' section");
  }
  if (!user.includes("Generate a single commit message")) {
    throw new Error("missing generation instruction");
  }
});

// -------------------------------------------------------------------
// 7. Token estimation
// -------------------------------------------------------------------
console.log("\n--- Token estimation ---");

check("estimateTokens returns reasonable values", () => {
  const t1 = estimateTokens("hello world"); // 11 chars
  if (t1 < 2 || t1 > 6) throw new Error(`unexpected token count: ${t1}`);

  const t2 = estimateTokens("a".repeat(350)); // 350 chars
  if (t2 < 50 || t2 > 150) throw new Error(`unexpected token count: ${t2}`);
});

check("estimateMessageTokens includes overhead", () => {
  const tokens = estimateMessageTokens([
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello." },
  ]);
  // 2 messages × 4 overhead + content tokens
  if (tokens < 8) throw new Error(`tokens too low: ${tokens}`);
});

check("long content produces more tokens than short", () => {
  const short = estimateMessageTokens([
    { role: "user", content: "hi" },
  ]);
  const long = estimateMessageTokens([
    { role: "user", content: "a".repeat(1000) },
  ]);
  if (long <= short) throw new Error("long content should have more tokens");
});

// -------------------------------------------------------------------
// 8. Integration: buildPrompt + real data shape
// -------------------------------------------------------------------
console.log("\n--- Integration checks ---");

check("works with realistic RetrieveResult shape from Day 2", () => {
  // This tests the exact data shape produced by the retrieve() function
  const realisticResults = [
    {
      entry: {
        hash: "daae9841234567890abcdef1234567890abcdef",
        message: "feat(day2): add embedding provider, indexing pipeline, and retrieval module",
        diffSummary: "diff --git a/packages/core/src/embedding.ts b/packages/core/src/embedding.ts\n...",
        vector: new Array(1024).fill(0.01),
      },
      score: 0.888,
    },
    {
      entry: {
        hash: "de8cec74b9a403493eeba37209ab018dd8da4ea2",
        message: "fix: add @types/node dependency and rebuild core package",
        diffSummary: "diff --git a/packages/core/src/git.ts b/packages/core/src/git.ts\n...",
        vector: new Array(1024).fill(0.02),
      },
      score: 0.813,
    },
  ];

  const messages = buildPrompt(SAMPLE_DIFF, realisticResults);
  const user = messages[1].content;

  // Should include both examples
  if (!user.includes("feat(day2): add embedding")) throw new Error("missing 1st example");
  if (!user.includes("fix: add @types/node")) throw new Error("missing 2nd example");

  // Should have similarity scores
  if (!user.includes("0.89") && !user.includes("0.88")) throw new Error("missing similarity");
  if (!user.includes("0.81")) throw new Error("missing 2nd similarity");

  console.log("         → prompt total tokens: ~" + estimateMessageTokens(messages));
  console.log("         → system prompt length: " + messages[0].content.length + " chars");
  console.log("         → user prompt length: " + messages[1].content.length + " chars");
});

// -------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);
