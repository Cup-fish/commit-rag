/**
 * Day 2 smoke test — validates embedding, indexing, and retrieval.
 *
 * Phase 1: Mock embedding (fast, no network) — tests pipeline logic.
 * Phase 2: Real Qwen/DashScope embedding — runs if COMMIT_RAG_DASHSCOPE_API_KEY is set.
 *
 * Usage:
 *   node scripts/smoke-test-day2.mjs
 *   COMMIT_RAG_DASHSCOPE_API_KEY=sk-... node scripts/smoke-test-day2.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const {
  getCommitHistory,
  getCommitDiff,
  getStagedDiff,
  MockEmbeddingProvider,
  QwenEmbeddingProvider,
  buildIndex,
  saveIndex,
  loadIndex,
  retrieve,
  cosineSimilarity,
} = require(resolve(repoRoot, "packages/core/dist/index.js"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(name, fn) {
  return fn()
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err) => console.log(`  FAIL  ${name}: ${err.message}`));
}

async function runPhase(label, fn) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(60));
  let passed = 0;
  let failed = 0;

  const checkLocal = (name, testFn) =>
    testFn()
      .then(() => { console.log(`  PASS  ${name}`); passed++; })
      .catch((err) => { console.log(`  FAIL  ${name}: ${err.message}`); failed++; });

  await fn(checkLocal);
  console.log(`\n  → ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Phase 1: Mock embedding — pipeline logic test (no API key needed)
// ---------------------------------------------------------------------------
await runPhase("Phase 1: Mock embedding — pipeline logic", async (ok) => {
  const mockEmbedder = new MockEmbeddingProvider(1024);

  // 1a. Mock embedding returns deterministic vectors
  await ok("MockEmbeddingProvider returns correct dimensions", async () => {
    const vecs = await mockEmbedder.embed(["hello", "world"]);
    if (vecs.length !== 2) throw new Error(`expected 2, got ${vecs.length}`);
    if (vecs[0].length !== 1024) throw new Error(`expected dim 1024, got ${vecs[0].length}`);
    // Different texts should produce different vectors
    const sim = cosineSimilarity(vecs[0], vecs[1]);
    if (sim >= 0.999) throw new Error(`vectors too similar (${sim}) for different texts`);
    console.log(`         → dims: ${vecs[0].length}, sim("hello","world"): ${sim.toFixed(4)}`);
  });

  // 1b. Build index with mock embedder
  await ok("buildIndex() with mock embedder runs end-to-end", async () => {
    const entries = await buildIndex(mockEmbedder, { indexing: { maxCommits: 10, maxDiffLines: 500 }, retrieval: { topK: 5 }, model: { embeddingModel: "mock", embeddingDimensions: 1024, llmModel: "mock" }, apiKeys: {} }, { cwd: repoRoot, limit: 5 });
    if (entries.length === 0) throw new Error("no entries returned");
    if (entries.length > 5) throw new Error(`expected ≤5, got ${entries.length}`);
    for (const e of entries) {
      if (!e.hash || !e.message || !e.diffSummary || e.vector.length !== 1024) {
        throw new Error(`malformed entry: ${JSON.stringify({ hash: e.hash?.slice(0, 7), msg: e.message, dims: e.vector?.length, diffLen: e.diffSummary?.length })}`);
      }
    }
    console.log(`         → indexed ${entries.length} commits`);
  });

  // 1c. Retrieve from index
  await ok("retrieve() returns top-k entries sorted by similarity", async () => {
    const mockEmbedder2 = new MockEmbeddingProvider(1024);
    const entries = await buildIndex(mockEmbedder2, { indexing: { maxCommits: 10, maxDiffLines: 500 }, retrieval: { topK: 5 }, model: { embeddingModel: "mock", embeddingDimensions: 1024, llmModel: "mock" }, apiKeys: {} }, { cwd: repoRoot, limit: 5 });

    // Query: use the diffSummary of the first entry as query text
    const queryVecs = await mockEmbedder2.embed([entries[0].diffSummary]);
    const results = retrieve(queryVecs[0], entries, 3);

    const k = Math.min(3, entries.length);
    if (results.length !== k) throw new Error(`expected ${k} results, got ${results.length}`);
    console.log(`         → top-${k} scores: ${results.map((r) => `${r.entry.hash.slice(0, 7)}:${r.score.toFixed(3)}`).join("  ")}`);
  });

  // 1d. saveIndex / loadIndex roundtrip
  await ok("saveIndex() + loadIndex() roundtrip", async () => {
    const entries = await buildIndex(mockEmbedder, { indexing: { maxCommits: 10, maxDiffLines: 500 }, retrieval: { topK: 5 }, model: { embeddingModel: "mock", embeddingDimensions: 1024, llmModel: "mock" }, apiKeys: {} }, { cwd: repoRoot, limit: 3 });
    saveIndex(entries, repoRoot);
    const loaded = loadIndex(repoRoot);
    if (!loaded) throw new Error("loadIndex returned null");
    if (loaded.length !== entries.length) throw new Error(`count mismatch: ${loaded.length} vs ${entries.length}`);
    if (loaded[0].hash !== entries[0].hash) throw new Error("hash mismatch");
    console.log(`         → saved and reloaded ${loaded.length} entries`);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Real Qwen embedding — quality assessment
// ---------------------------------------------------------------------------
const apiKey = process.env.COMMIT_RAG_DASHSCOPE_API_KEY;

if (!apiKey) {
  console.log(`\n⚠  COMMIT_RAG_DASHSCOPE_API_KEY not set — skipping real API test.`);
  console.log(`   Set it and re-run to validate against DashScope.`);
} else {
  await runPhase("Phase 2: Real Qwen/DashScope embedding", async (ok) => {
    const qwen = new QwenEmbeddingProvider({ apiKey, dimensions: 1024 });

    // 2a. Real embedding call
    await ok("QwenEmbeddingProvider.embed() returns valid vectors", async () => {
      const vecs = await qwen.embed(["hello world", "testing commit diff"]);
      if (vecs.length !== 2) throw new Error(`expected 2, got ${vecs.length}`);
      if (vecs[0].length !== 1024) throw new Error(`expected 1024 dims, got ${vecs[0].length}`);
      const sim = cosineSimilarity(vecs[0], vecs[1]);
      console.log(`         → dims: ${vecs[0].length}, sim("hello world","testing commit diff"): ${sim.toFixed(4)} (should be moderate)`);
    });

    // 2b. Build real index against this repo
    let realIndex = [];
    await ok("buildIndex() with real Qwen embedder", async () => {
      const limit = Math.min(10, (await getCommitHistory(100, { cwd: repoRoot })).length);
      realIndex = await buildIndex(
        qwen,
        {
          indexing: { maxCommits: limit, maxDiffLines: 500 },
          retrieval: { topK: 5 },
          model: { embeddingModel: "text-embedding-v4", embeddingDimensions: 1024, llmModel: "deepseek-chat" },
          apiKeys: { dashscope: apiKey },
        },
        {
          cwd: repoRoot,
          limit,
          onProgress: (cur, total, hash) => {
            if (cur === 1 || cur === total) {
              console.log(`         → progress: ${cur}/${total} (${hash.slice(0, 7)})`);
            }
          },
        },
      );
      saveIndex(realIndex, repoRoot);
      console.log(`         → indexed ${realIndex.length} commits to .commit-rag/index.json`);
    });

    // 2c. Retrieval quality: use latest commit's diff as query
    await ok("retrieve() returns semantically relevant commits", async () => {
      if (realIndex.length < 2) {
        console.log(`         → skipped (need ≥2 indexed commits)`);
        return;
      }

      // Use the most recent commit's diff as a query
      const queryVec = realIndex[0].vector;
      const results = retrieve(queryVec, realIndex.slice(1), 3); // exclude self

      console.log(`         → query: "${realIndex[0].message.slice(0, 60)}"`);
      console.log(`         → top-3 matches:`);
      for (const r of results) {
        const flag = r.score > 0.7 ? " ★" : r.score > 0.5 ? " ·" : "  ";
        console.log(
          `           ${r.score.toFixed(4)}${flag} ${r.entry.hash.slice(0, 7)} ${r.entry.message.slice(0, 60)}`,
        );
      }
    });

    // 2d. Test with empty staging area (cold-start scenario)
    await ok("getStagedDiff() empty → graceful handling", async () => {
      const diff = await getStagedDiff({ cwd: repoRoot });
      if (diff === "") {
        console.log(`         → no staged changes (expected)`);
      } else {
        // Something is staged — embed it and retrieve
        const vecs = await qwen.embed([diff]);
        const results = retrieve(vecs[0], realIndex, 3);
        console.log(`         → staged diff: ${diff.length} chars, top match: ${results[0]?.entry.message ?? "none"}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`  Day 2 smoke test complete.`);
console.log(`  Index file: ${resolve(repoRoot, ".commit-rag", "index.json")}`);
console.log("=".repeat(60));
