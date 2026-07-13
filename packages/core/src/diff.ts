/**
 * Shared git diff parsing utilities.
 *
 * Used by both the indexing pipeline (indexer.ts) and prompt construction
 * (prompt.ts) to extract file-level statistics from unified diff output.
 * Extracted here to avoid duplication.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffFileStat {
  /** File path (from the `b/` side of `diff --git a/X b/Y`). */
  file: string;
  /** Number of added lines (+ prefix, excluding +++ headers). */
  adds: number;
  /** Number of deleted lines (- prefix, excluding --- headers). */
  dels: number;
}

export interface DiffParseResult {
  /** Per-file add/delete counts, in the order they appear in the diff. */
  stats: DiffFileStat[];
  /**
   * Non-content structural lines: diff --git headers, ---/+++ lines,
   * @@ hunk headers. Useful for summarisation.
   */
  structuralLines: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string and extract per-file statistics.
 *
 * This is intentionally regex-based rather than a full diff parser — we only
 * need file names and +/- line counts for summarisation, not a complete AST.
 */
export function parseDiff(diff: string): DiffParseResult {
  const lines = diff.split("\n");
  const stats: DiffFileStat[] = [];
  const structuralLines: string[] = [];
  let currentFile = "";

  for (const line of lines) {
    // "diff --git a/path b/path" → new file
    const dm = /^diff --git a\/(.*) b\/(.*)/.exec(line);
    if (dm) {
      currentFile = dm[2] || dm[1];
      structuralLines.push(line);
      stats.push({ file: currentFile, adds: 0, dels: 0 });
      continue;
    }

    // --- / +++ headers and @@ hunk headers are structural
    if (
      /^--- (a\/)?/.test(line) ||
      /^\+\+\+ (b\/)?/.test(line) ||
      /^@@ /.test(line)
    ) {
      structuralLines.push(line);
      continue;
    }

    // Count + and - lines for the current file
    if (currentFile && stats.length > 0) {
      const last = stats[stats.length - 1];
      if (/^\+[^+]/.test(line)) last.adds++;
      else if (/^-[^-]/.test(line)) last.dels++;
    }
  }

  return { stats, structuralLines };
}
