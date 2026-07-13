/**
 * Indexing pipeline for commit-rag.
 *
 * Walks the repository's commit history, extracts a diff summary for each
 * commit, embeds it via the configured EmbeddingProvider, and persists the
 * resulting index to `.commit-rag/index.json`.
 *
 * Design doc reference: §3.3
 */

import * as fs from "fs";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";
import type { CommitEntry } from "./git";
import { getCommitHistory, getCommitDiff } from "./git";
import type { CommitRagConfig } from "./config";
import { parseDiff } from "./diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexEntry {
  /** Full 40-char commit SHA. */
  hash: string;
  /** Commit subject line. */
  message: string;
  /**
   * The text that was embedded — either the full diff or a summary
   * (file list + stats) when the diff was too large.
   */
  diffSummary: string;
  /** Embedding vector. */
  vector: number[];
}

export interface BuildIndexOptions {
  /** Repository root path. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Max commits to index. Default from config (200). */
  limit?: number;
  /** Called after each commit is processed. */
  onProgress?: (current: number, total: number, hash: string) => void;
}

/**
 * Default path for the index file relative to the repo root.
 */
export const INDEX_DIR = ".commit-rag";
export const INDEX_FILE = "index.json";

// ---------------------------------------------------------------------------
// Diff summarization
// ---------------------------------------------------------------------------

/**
 * When a diff is too large (e.g. mass formatting), embedding the full content
 * wastes tokens and dilutes the vector quality. Instead, we extract:
 * - List of changed files
 * - +N / -N line counts per file
 * - First ~100 lines of actual diff for semantic signal
 *
 * Design doc reference: §3.3 bullet 2, §6 risk 1
 */
function summarizeDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const { stats, structuralLines } = parseDiff(diff);

  const parts: string[] = [
    `# Diff summary (${lines.length} total lines, summarised to avoid token blowout)`,
    "",
    "## Changed files",
    ...stats.map(
      (s) => `  ${s.file}  (+${s.adds} -${s.dels})`,
    ),
    "",
    "## Diff headers",
    ...structuralLines.slice(0, 200), // cap structural lines too
    "",
    "## Diff content (first portion)",
    ...lines.slice(0, Math.min(100, lines.length)),
  ];

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Index persistence
// ---------------------------------------------------------------------------

/**
 * Save index entries to `.commit-rag/index.json`.
 */
export function saveIndex(
  entries: IndexEntry[],
  cwd: string = process.cwd(),
): void {
  const dir = path.join(cwd, INDEX_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const indexPath = path.join(dir, INDEX_FILE);
  // Write atomically: write to temp file first, then rename
  const tmpPath = indexPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf-8");
  fs.renameSync(tmpPath, indexPath);
}

/**
 * Load index entries from `.commit-rag/index.json`.
 * Returns `null` if the file doesn't exist (e.g. first run).
 */
export function loadIndex(cwd: string = process.cwd()): IndexEntry[] | null {
  const indexPath = path.join(cwd, INDEX_DIR, INDEX_FILE);
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as IndexEntry[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index builder
// ---------------------------------------------------------------------------

/**
 * Build the RAG index from the repository's commit history.
 *
 * Steps (per design doc §3.3):
 * 1. Fetch the N most recent commits.
 * 2. For each commit: get the diff, summarize if too large, embed it.
 * 3. Return the list of {hash, message, diffSummary, vector} entries.
 *
 * The caller should call `saveIndex()` afterwards to persist.
 */
export async function buildIndex(
  embedder: EmbeddingProvider,
  config: CommitRagConfig,
  options: BuildIndexOptions = {},
): Promise<IndexEntry[]> {
  const cwd = options.cwd ?? process.cwd();
  const limit = options.limit ?? config.indexing.maxCommits;
  const maxDiffLines = config.indexing.maxDiffLines;

  // 1. Fetch commit history
  const commits: CommitEntry[] = await getCommitHistory(limit, { cwd });

  if (commits.length === 0) {
    return [];
  }

  // 2. Collect diff summaries (in batches for embedding efficiency)
  const diffTexts: string[] = [];
  const entries: Array<Omit<IndexEntry, "vector">> = [];

  for (let i = 0; i < commits.length; i++) {
    const { hash, message } = commits[i];
    options.onProgress?.(i + 1, commits.length, hash);

    let diff: string;
    try {
      diff = await getCommitDiff(hash, { cwd });
    } catch {
      // Some commits (e.g. very large initial commits) may fail.
      // Record a placeholder so the index isn't blocked.
      diff = `(unable to retrieve diff for ${hash.slice(0, 7)})`;
    }

    const diffSummary = summarizeDiff(diff, maxDiffLines);
    diffTexts.push(diffSummary);
    entries.push({ hash, message, diffSummary });
  }

  // 3. Embed all diffs in one batch (embedder handles internal batching)
  const vectors = await embedder.embed(diffTexts);

  // Safety: ensure embedder returned the expected number of vectors
  if (vectors.length !== entries.length) {
    throw new Error(
      `Embedding mismatch: ${entries.length} commits but ` +
        `embedder returned ${vectors.length} vectors. ` +
        `The embedder must return exactly one vector per input text.`,
    );
  }

  // 4. Combine
  const result: IndexEntry[] = entries.map((entry, idx) => ({
    ...entry,
    vector: vectors[idx],
  }));

  return result;
}
