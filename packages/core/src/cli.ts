#!/usr/bin/env node
/**
 * commit-rag CLI
 *
 * IDE-independent command-line interface for the commit-rag core engine.
 * Used by JetBrains (and other non-JS IDE) plugins to invoke the RAG
 * pipeline via subprocess.
 *
 * All output is JSON to stdout.  Use the `status` field to distinguish
 * success ("ok") from error ("error").  Exit code 0 = success, 1 = error.
 *
 * Usage:
 *   commit-rag-cli index    [--repo <path>]
 *   commit-rag-cli generate [--repo <path>]
 *
 * Design doc reference: Phase 2 §5.0 — CLI for JetBrains subprocess calls.
 */

import { loadConfig } from "./config";
import { getStagedDiff } from "./git";
import { QwenEmbeddingProvider } from "./embedding";
import { buildIndex, saveIndex, loadIndex, INDEX_DIR, INDEX_FILE } from "./indexer";
import { retrieve } from "./retrieve";
import { buildPrompt } from "./prompt";
import { generateCommitMessage } from "./llm";
import type { IndexEntry } from "./indexer";
import type { RetrieveResult } from "./retrieve";

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------

/** Print a success response to stdout and exit 0. */
function ok(data: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ status: "ok", ...data }) + "\n");
  process.exit(0);
}

/** Print an error response to stdout and exit 1. */
function fail(error: string, code?: string): never {
  const payload: Record<string, unknown> = { status: "error", error };
  if (code) payload.code = code;
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  repoPath: string;
}

function parseArgs(raw: string[]): ParsedArgs {
  const positional: string[] = [];
  let repoPath = process.cwd();

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--repo" || arg === "-r") {
      repoPath = raw[++i];
      if (!repoPath) {
        fail("--repo requires a path argument", "INVALID_ARGS");
      }
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      fail(`Unknown option: ${arg}\nUse --help for usage.`, "INVALID_ARGS");
    }
  }

  if (positional.length === 0) {
    fail("No command specified.\nUse --help for usage.", "INVALID_ARGS");
  }

  const command = positional[0].toLowerCase();
  if (command !== "index" && command !== "generate") {
    fail(
      `Unknown command: "${positional[0]}". Supported: index, generate.\nUse --help for usage.`,
      "INVALID_ARGS",
    );
  }

  return { command, repoPath };
}

function printHelp(): void {
  process.stdout.write(`commit-rag-cli — AI-powered commit message generator (RAG over git history)

USAGE
  commit-rag-cli <command> [--repo <path>]

COMMANDS
  index       Build (or rebuild) the RAG index from the repo's commit history.
              Requires: COMMIT_RAG_DASHSCOPE_API_KEY environment variable.

  generate    Generate a commit message for the currently staged changes.
              Requires: COMMIT_RAG_DASHSCOPE_API_KEY and COMMIT_RAG_DEEPSEEK_API_KEY.
              The index must already exist (run "index" first).

OPTIONS
  --repo, -r  Path to the git repository root. Default: current working directory.
  --help, -h  Show this help message.

OUTPUT
  All output is JSON to stdout with a "status" field: "ok" or "error".
  Exit code 0 = success, 1 = error.

EXAMPLES
  commit-rag-cli index --repo /path/to/repo
  commit-rag-cli generate --repo /path/to/repo
`);
}

// ---------------------------------------------------------------------------
// Sub-command: index
// ---------------------------------------------------------------------------

async function cmdIndex(repoPath: string): Promise<never> {
  // 1. Load config (reads rc file + env vars)
  const config = loadConfig(repoPath);

  // 2. Validate embedding API key
  if (!config.apiKeys.dashscope) {
    fail(
      "DashScope API key not configured.\n\n" +
        "Set the COMMIT_RAG_DASHSCOPE_API_KEY environment variable.\n" +
        "Get a key at: https://dashscope.console.aliyun.com/apiKey",
      "MISSING_DASHSCOPE_KEY",
    );
  }

  // 3. Create embedder
  const embedder = new QwenEmbeddingProvider({
    apiKey: config.apiKeys.dashscope,
    model: config.model.embeddingModel,
    dimensions: config.model.embeddingDimensions,
  });

  // 4. Build the index
  const startTime = Date.now();
  const entries: IndexEntry[] = await buildIndex(embedder, config, {
    cwd: repoPath,
    onProgress: (current, total, hash) => {
      // Emit progress as JSON lines to stderr so callers can stream-read it
      process.stderr.write(
        JSON.stringify({
          type: "progress",
          current,
          total,
          hash: hash.slice(0, 7),
        }) + "\n",
      );
    },
  });

  // 5. Persist
  saveIndex(entries, repoPath);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  ok({
    indexedCommits: entries.length,
    indexPath: `${repoPath}/${INDEX_DIR}/${INDEX_FILE}`,
    elapsedSeconds: parseFloat(elapsed),
  });
}

// ---------------------------------------------------------------------------
// Sub-command: generate
// ---------------------------------------------------------------------------

async function cmdGenerate(repoPath: string): Promise<never> {
  // 1. Load config
  const config = loadConfig(repoPath);

  // 2. Validate API keys
  if (!config.apiKeys.dashscope) {
    fail(
      "DashScope API key not configured.\n\n" +
        "Set the COMMIT_RAG_DASHSCOPE_API_KEY environment variable.",
      "MISSING_DASHSCOPE_KEY",
    );
  }
  if (!config.apiKeys.deepseek) {
    fail(
      "DeepSeek API key not configured.\n\n" +
        "Set the COMMIT_RAG_DEEPSEEK_API_KEY environment variable.",
      "MISSING_DEEPSEEK_KEY",
    );
  }

  // 3. Get staged diff
  let stagedDiff: string;
  try {
    stagedDiff = await getStagedDiff({ cwd: repoPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Failed to read staged diff: ${message}`, "GIT_ERROR");
  }

  if (!stagedDiff.trim()) {
    fail(
      "No staged changes found. Stage your changes with 'git add' first.",
      "NO_STAGED_CHANGES",
    );
  }

  // 4. Load the pre-built index
  let indexEntries: IndexEntry[] | null = loadIndex(repoPath);
  if (indexEntries === null) {
    fail(
      "No index found. Run 'commit-rag-cli index' first to build the RAG index.",
      "NO_INDEX",
    );
  }

  // 5. Embed the staged diff
  const embedder = new QwenEmbeddingProvider({
    apiKey: config.apiKeys.dashscope,
    model: config.model.embeddingModel,
    dimensions: config.model.embeddingDimensions,
  });

  const [queryVector] = await embedder.embed([stagedDiff]);

  // 6. Retrieve similar historical commits
  const retrieved: RetrieveResult[] = retrieve(
    queryVector,
    indexEntries,
    config.retrieval.topK,
  );

  // 7. Build prompt
  const messages = buildPrompt(stagedDiff, retrieved, {
    language: config.language.preferred,
  });

  // 8. Generate commit message via DeepSeek
  const result = await generateCommitMessage(messages, {
    apiKey: config.apiKeys.deepseek,
    model: config.model.llmModel,
  });

  // 9. Return result
  ok({
    message: result.message,
    usage: result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        }
      : undefined,
    model: result.model,
    retrievedCount: retrieved.length,
    topScores: retrieved.slice(0, 3).map((r) => ({
      hash: r.entry.hash.slice(0, 7),
      message: r.entry.message,
      score: parseFloat(r.score.toFixed(4)),
    })),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  try {
    switch (args.command) {
      case "index":
        await cmdIndex(args.repoPath);
        break;
      case "generate":
        await cmdGenerate(args.repoPath);
        break;
      default:
        // Should be caught by parseArgs, but be defensive
        fail(`Unknown command: ${args.command}`, "INVALID_ARGS");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message, "UNEXPECTED_ERROR");
  }
}

main();
