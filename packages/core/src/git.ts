/**
 * Git interface layer for commit-rag.
 *
 * Uses `child_process.execFile` rather than `exec` to avoid shell injection:
 * `execFile` passes arguments as an array directly to the git binary without
 * going through a shell, so special characters in arguments (branch names,
 * file paths, etc.) cannot be used to inject arbitrary commands.
 *
 * All functions accept an optional `cwd` to specify the repo root; defaults
 * to `process.cwd()`.
 */

import { execFile } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitEntry {
  hash: string;
  message: string;
}

export interface GitOptions {
  /** Path to the git repository root. Defaults to `process.cwd()`. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Execute `git` with the given arguments and return stdout as a UTF-8 string.
 *
 * Security note: we use `execFile` so args are passed directly to the git
 * binary without a shell — this avoids injection through file paths, branch
 * names, or commit messages that might contain shell metacharacters.
 */
function execGit(
  args: string[],
  options?: GitOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd: options?.cwd ?? process.cwd(),
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10 MB — generous enough for large diffs
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "git is not installed or not found in PATH. " +
              "Please install git and ensure it is available on your PATH.",
          ),
        );
      } else {
        reject(new Error(`Failed to execute git: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        // git writes diagnostic messages to stderr
        reject(
          new Error(
            `git exited with code ${code}${stderr ? ": " + stderr.trim() : ""}`,
          ),
        );
      }
    });
  });
}

/**
 * Validate that a commit hash looks like a valid SHA-1 hex string.
 * Does NOT check whether the commit actually exists — that's left to git.
 */
function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(hash);
}

// ---------------------------------------------------------------------------
// Public API — matches the three functions specified in the design doc §3.1
// ---------------------------------------------------------------------------

/**
 * Get the diff of currently staged changes.
 *
 * Equivalent to `git diff --cached --unified=3`.
 * Returns an empty string when nothing is staged — not an error.
 *
 * @throws if git is not installed, or cwd is not inside a git repository.
 */
export async function getStagedDiff(options?: GitOptions): Promise<string> {
  return execGit(["diff", "--cached", "--unified=3"], options);
}

/**
 * Get the most recent N commits from the current branch.
 *
 * Each entry has `hash` (full 40-char SHA) and `message` (subject line only).
 * Returns an empty array for a repo with no commits yet.
 *
 * @param limit  Max number of commits to fetch. Default 200 (per design doc).
 * @throws if git is not installed, or cwd is not inside a git repository.
 */
export async function getCommitHistory(
  limit: number = 200,
  options?: GitOptions,
): Promise<CommitEntry[]> {
  // Use a custom format: full hash + subject, separated by |.
  // We use %H (full hash) rather than %h so we can pass it to `git show`.
  const raw = await execGit(
    ["log", "--pretty=format:%H|%s", `-n${Math.max(1, limit)}`],
    options,
  );

  if (!raw.trim()) {
    return [];
  }

  const lines = raw.trim().split("\n");
  const entries: CommitEntry[] = [];

  for (const line of lines) {
    const sepIdx = line.indexOf("|");
    if (sepIdx === -1) continue; // defensive — shouldn't happen with our format

    entries.push({
      hash: line.slice(0, sepIdx),
      message: line.slice(sepIdx + 1),
    });
  }

  return entries;
}

/**
 * Get the diff associated with a specific historical commit.
 *
 * Equivalent to `git show <hash> --unified=1`.
 * Uses `--unified=1` (less context) because these diffs go into the RAG
 * index — we want the essence of the change, not full surrounding context.
 *
 * @param hash  Full or abbreviated commit SHA (≥7 hex chars).
 * @throws if the hash format is invalid, or if git fails (e.g. hash not found).
 */
export async function getCommitDiff(
  hash: string,
  options?: GitOptions,
): Promise<string> {
  if (!isValidHash(hash)) {
    throw new Error(
      `Invalid commit hash "${hash}": expected a hex SHA of 7–40 characters.`,
    );
  }

  return execGit(["show", hash, "--unified=1"], options);
}
