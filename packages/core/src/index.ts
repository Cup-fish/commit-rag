/**
 * @commit-rag/core
 *
 * IDE-independent core engine for the commit-rag project.
 *
 * Exports (by design-doc module):
 *   git.ts        — Git interface layer (§3.1)
 *   embedding.ts  — Embedding provider abstraction (§3.2)
 *   indexer.ts    — Indexing pipeline (§3.3)
 *   retrieve.ts   — Retrieval with cosine similarity (§3.4)
 *   config.ts     — Configuration management (§3.7)
 *
 * Coming later:
 *   prompt.ts     — Prompt construction (§3.5, Day 3)
 *   llm.ts        — DeepSeek generation (§3.6, Day 4)
 */

// Git
export { getStagedDiff, getCommitHistory, getCommitDiff } from "./git";
export type { CommitEntry, GitOptions } from "./git";

// Embedding
export { QwenEmbeddingProvider, MockEmbeddingProvider } from "./embedding";
export type { EmbeddingProvider, QwenEmbeddingOptions } from "./embedding";

// Indexer
export { buildIndex, saveIndex, loadIndex, INDEX_DIR, INDEX_FILE } from "./indexer";
export type { IndexEntry, BuildIndexOptions } from "./indexer";

// Retrieval
export { retrieve, retrieveBestMessage, cosineSimilarity } from "./retrieve";
export type { RetrieveResult } from "./retrieve";

// Config
export { loadConfig, loadDefaultConfig } from "./config";
export type { CommitRagConfig } from "./config";
