/**
 * Retrieval module for commit-rag.
 *
 * Given the current staged diff (as a query vector), finds the k most similar
 * historical commits from the index using cosine similarity.
 *
 * MVP implementation: brute-force scan + cosine similarity.
 * For repos with < 1000 indexed commits this is more than fast enough.
 * If scaling is needed, mention hnswlib-node as the upgrade path.
 *
 * Design doc reference: §3.4
 */

import type { IndexEntry } from "./indexer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrieveResult {
  /** The matching index entry. */
  entry: IndexEntry;
  /** Cosine similarity score in [0, 1]. Higher = more similar. */
  score: number;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity between two vectors of equal dimension.
 *
 * Returns a value in [-1, 1]. For embedding vectors from modern models
 * (which are typically L2-normalized or close to it), the practical range
 * is roughly [0, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0; // zero vectors

  return dotProduct / denominator;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve the top-K most similar commits from the index for a given query.
 *
 * @param queryVector  Embedding vector of the current staged diff.
 * @param index        Pre-built index from `buildIndex()` / `loadIndex()`.
 * @param topK         Number of results to return. Default 5 (per design doc).
 * @returns Sorted array of results, highest similarity first. May be empty
 *          if the index is empty.
 */
export function retrieve(
  queryVector: number[],
  index: IndexEntry[],
  topK: number = 5,
): RetrieveResult[] {
  if (index.length === 0) return [];
  if (queryVector.length === 0) return [];

  const scored: RetrieveResult[] = index.map((entry) => ({
    entry,
    score: cosineSimilarity(queryVector, entry.vector),
  }));

  // Sort descending by similarity
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Convenience: batch query
// ---------------------------------------------------------------------------

/**
 * Quick check: given a query vector, return the best-matching commit message
 * or `null` if the index is empty / nothing matches above a minimum threshold.
 *
 * @param minScore  Minimum cosine similarity to consider a match (default 0).
 *                  Set higher to avoid returning irrelevant commits for
 *                  cold-start repos.
 */
export function retrieveBestMessage(
  queryVector: number[],
  index: IndexEntry[],
  minScore: number = 0,
): string | null {
  const results = retrieve(queryVector, index, 1);
  if (results.length === 0 || results[0].score < minScore) return null;
  return results[0].entry.message;
}
