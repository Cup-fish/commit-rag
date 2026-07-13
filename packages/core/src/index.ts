/**
 * @commit-rag/core
 *
 * IDE-independent core engine for the commit-rag project.
 *
 * Exports (by design-doc module):
 *   git.ts        — Git interface layer (§3.1)
 *   embedding.ts  — Embedding provider abstraction (§3.2)
 *   diff.ts       — Shared diff parsing utilities
 *   indexer.ts    — Indexing pipeline (§3.3)
 *   retrieve.ts   — Retrieval with cosine similarity (§3.4)
 *   prompt.ts     — Prompt construction (§3.5)
 *   llm.ts        — DeepSeek generation (§3.6)
 *   config.ts     — Configuration management (§3.7)
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

// Prompt
export { buildPrompt, estimateTokens, estimateMessageTokens } from "./prompt";
export type { ChatMessage, PromptOptions } from "./prompt";

// LLM
export { generateCommitMessage } from "./llm";
export type { LlmOptions, LlmUsage, GenerationResult } from "./llm";

// Config
export { loadConfig, loadDefaultConfig } from "./config";
export type { CommitRagConfig } from "./config";
