/**
 * Configuration management for commit-rag.
 *
 * Resolution order (later wins):
 * 1. Hard-coded defaults
 * 2. `.commitragrc.json` in the repository root
 * 3. Environment variables
 *
 * API keys are ONLY read from environment variables — they are NEVER
 * written to `.commitragrc.json` or any other file.
 *
 * Design doc reference: §3.7
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitRagConfig {
  /** API keys (env-only, never persisted to disk). */
  apiKeys: {
    /** DashScope / Alibaba Cloud API key for Qwen embedding. */
    dashscope?: string;
    /** DeepSeek API key for LLM generation (Day 4+). */
    deepseek?: string;
  };

  indexing: {
    /** Maximum number of historical commits to index. */
    maxCommits: number;
    /**
     * Diff lines threshold: if a commit's diff exceeds this, it will be
     * summarized (file list + stats) instead of embedding the full content.
     */
    maxDiffLines: number;
  };

  retrieval: {
    /** Number of similar historical commits to retrieve as few-shot examples. */
    topK: number;
  };

  model: {
    /** DashScope embedding model name. */
    embeddingModel: string;
    /** Embedding vector dimensions. */
    embeddingDimensions: number;
    /** DeepSeek LLM model name (Day 4+). */
    llmModel: string;
  };

  /** Commit message language preference. */
  language: {
    /**
     * "auto" = follow the project's historical commit language
     * "zh"   = Chinese
     * "en"   = English
     */
    preferred: "auto" | "zh" | "en";
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaults(): CommitRagConfig {
  return {
    apiKeys: {},
    indexing: {
      maxCommits: 200,
      maxDiffLines: 500,
    },
    retrieval: {
      topK: 5,
    },
    model: {
      embeddingModel: "text-embedding-v4",
      embeddingDimensions: 1024,
      llmModel: "deepseek-chat",
    },
    language: {
      preferred: "auto",
    },
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Read a `.commitragrc.json` file if present and merge into config.
 */
function applyRcFile(config: CommitRagConfig, repoRoot: string): void {
  const rcPath = path.join(repoRoot, ".commitragrc.json");
  let rc: unknown;
  try {
    rc = JSON.parse(fs.readFileSync(rcPath, "utf-8"));
  } catch {
    return; // missing or malformed — not fatal
  }
  if (rc === null || typeof rc !== "object") return;

  const r = rc as Record<string, unknown>;

  if (typeof r.indexing === "object" && r.indexing !== null) {
    const idx = r.indexing as Record<string, unknown>;
    if (typeof idx.maxCommits === "number") config.indexing.maxCommits = idx.maxCommits;
    if (typeof idx.maxDiffLines === "number") config.indexing.maxDiffLines = idx.maxDiffLines;
  }
  if (typeof r.retrieval === "object" && r.retrieval !== null) {
    const ret = r.retrieval as Record<string, unknown>;
    if (typeof ret.topK === "number") config.retrieval.topK = ret.topK;
  }
  if (typeof r.model === "object" && r.model !== null) {
    const mdl = r.model as Record<string, unknown>;
    if (typeof mdl.embeddingModel === "string") config.model.embeddingModel = mdl.embeddingModel;
    if (typeof mdl.embeddingDimensions === "number") config.model.embeddingDimensions = mdl.embeddingDimensions;
    if (typeof mdl.llmModel === "string") config.model.llmModel = mdl.llmModel;
  }
  if (typeof r.language === "object" && r.language !== null) {
    const lang = r.language as Record<string, unknown>;
    if (lang.preferred === "auto" || lang.preferred === "zh" || lang.preferred === "en") {
      config.language.preferred = lang.preferred;
    }
  }
  // Note: apiKeys in rc file are intentionally ignored — see §3.7
}

/**
 * Apply environment variable overrides.
 *
 * Supported vars:
 * - COMMIT_RAG_DASHSCOPE_API_KEY
 * - COMMIT_RAG_DEEPSEEK_API_KEY
 * - COMMIT_RAG_MAX_COMMITS
 * - COMMIT_RAG_MAX_DIFF_LINES
 * - COMMIT_RAG_TOP_K
 * - COMMIT_RAG_EMBEDDING_MODEL
 * - COMMIT_RAG_EMBEDDING_DIMS
 * - COMMIT_RAG_LLM_MODEL
 */
function applyEnvOverrides(config: CommitRagConfig): void {
  const env = process.env;

  if (env.COMMIT_RAG_DASHSCOPE_API_KEY) {
    config.apiKeys.dashscope = env.COMMIT_RAG_DASHSCOPE_API_KEY;
  }
  if (env.COMMIT_RAG_DEEPSEEK_API_KEY) {
    config.apiKeys.deepseek = env.COMMIT_RAG_DEEPSEEK_API_KEY;
  }

  const maxCommits = parseInt(env.COMMIT_RAG_MAX_COMMITS ?? "", 10);
  if (!isNaN(maxCommits)) config.indexing.maxCommits = maxCommits;

  const maxDiffLines = parseInt(env.COMMIT_RAG_MAX_DIFF_LINES ?? "", 10);
  if (!isNaN(maxDiffLines)) config.indexing.maxDiffLines = maxDiffLines;

  const topK = parseInt(env.COMMIT_RAG_TOP_K ?? "", 10);
  if (!isNaN(topK)) config.retrieval.topK = topK;

  if (env.COMMIT_RAG_EMBEDDING_MODEL) {
    config.model.embeddingModel = env.COMMIT_RAG_EMBEDDING_MODEL;
  }
  const dims = parseInt(env.COMMIT_RAG_EMBEDDING_DIMS ?? "", 10);
  if (!isNaN(dims)) config.model.embeddingDimensions = dims;

  if (env.COMMIT_RAG_LLM_MODEL) {
    config.model.llmModel = env.COMMIT_RAG_LLM_MODEL;
  }

  const lang = env.COMMIT_RAG_LANGUAGE;
  if (lang === "auto" || lang === "zh" || lang === "en") {
    config.language.preferred = lang;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the full configuration for a given repository root.
 *
 * API keys ONLY come from environment variables (never from rc file).
 */
export function loadConfig(repoRoot: string): CommitRagConfig {
  const config = defaults();
  applyRcFile(config, repoRoot);
  applyEnvOverrides(config);
  return config;
}

/**
 * Convenience — load config with cwd as the repo root.
 */
export function loadDefaultConfig(): CommitRagConfig {
  return loadConfig(process.cwd());
}
