/**
 * Prompt construction for commit-rag.
 *
 * Builds the system + user messages sent to the LLM (DeepSeek).
 * The key insight (§3.5): the system prompt instructs the model to learn
 * the *project's own* type/scope conventions from the few-shot examples,
 * rather than applying generic Conventional Commits rules.
 *
 * Also handles diff truncation for the current staged changes so a massive
 * diff doesn't blow the token budget (§6 risk 1).
 *
 * Design doc reference: §3.5
 */

import type { RetrieveResult } from "./retrieve";
import { parseDiff } from "./diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in OpenAI-compatible chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptOptions {
  /**
   * Maximum lines of the *current* staged diff to include verbatim.
   * Beyond this threshold the diff is summarised (file list + stats).
   * Default: 300 (lower than indexer's 500 — the prompt is more token-sensitive).
   */
  maxCurrentDiffLines?: number;

  /**
   * Maximum characters per few-shot diff example.
   * Keeps the few-shot section from dominating the prompt.
   * Default: 1500.
   */
  maxExampleDiffChars?: number;

  /**
   * Maximum number of few-shot examples to include (even if retrieval returned more).
   * Default: 5 (matches default topK).
   */
  maxExamples?: number;

  /**
   * Preferred commit message language.
   * "auto" = follow the project's historical commits (default)
   * "zh"   = Chinese
   * "en"   = English
   */
  language?: "auto" | "zh" | "en";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt.
 *
 * The wording is carefully tuned:
 * 1. Specifies Conventional Commits as a baseline format.
 * 2. Emphasises that the model should COPY the project's existing conventions
 *    (type names, scope patterns, language, formatting) rather than inventing
 *    its own — this is where RAG delivers value over a naive LLM call.
 * 3. Includes explicit formatting rules (length, mood, no period).
 */
const SYSTEM_PROMPT = `You are an expert at writing git commit messages. Your task is to generate a single, well-formed commit message for a set of staged code changes.

## Format

Use the Conventional Commits specification:

\`\`\`
<type>(<optional-scope>): <subject>

<optional-body>
\`\`\`

## Rules

- **Subject line**: ≤72 characters, imperative mood ("add" not "added"), no trailing period.
- **Body** (optional): only if the change is complex enough to need explanation. Explain WHAT changed and WHY. Wrap at 72 characters.
- **Language**: {{LANGUAGE_RULE}}

## Learning the project's conventions (CRITICAL)

Below are examples of **real commits from this repository** that were similar to the current change. These examples show:

- What **type** prefixes this project uses (feat, fix, chore, docs, refactor, etc.)
- What **scopes** (if any) the project uses
- How messages are **capitalised**, **punctuated**, and **structured**
- Whether the project prefers **concise** or **verbose** messages

**Copy the conventions you see in the examples.** Do NOT apply your own generic knowledge of Conventional Commits — this project may have its own norms that differ from the standard. If the examples use a specific type for a certain kind of change, use that same type.`;

// ---------------------------------------------------------------------------
// Diff truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a diff for inclusion in the prompt.
 *
 * If the diff is short enough, return it verbatim. Otherwise, produce a
 * summary with file list, per-file stats, and the first portion of the
 * actual diff content — similar to the indexer's approach but tuned for
 * the LLM's context window rather than embedding quality.
 *
 * Design doc reference: §3.5 bullet 3, §6 risk 1
 */
function truncateCurrentDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const { stats } = parseDiff(diff);
  const contentLines = Math.min(200, Math.floor(maxLines * 0.7));

  const parts: string[] = [
    `[Diff truncated: ${lines.length} total lines → summary + first ${contentLines} lines of content]`,
    "",
    "## Changed files",
    ...stats.map((s) => `  ${s.file}  (+${s.adds} −${s.dels})`),
    "",
    "## Diff (first portion)",
    ...lines.slice(0, contentLines),
  ];

  return parts.join("\n");
}

/**
 * Truncate a single few-shot diff example to keep the prompt compact.
 */
function truncateExampleDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  // Take the first N chars, then append a summary of what was cut
  const head = diff.slice(0, maxChars);
  const remaining = diff.length - maxChars;
  const fileNames = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.*) b\/(.*)/gm)) {
    fileNames.add(m[2] || m[1]);
  }

  return (
    head +
    `\n... [truncated ${remaining} chars; ` +
    `${fileNames.size} file(s): ${[...fileNames].join(", ")}]`
  );
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Build the full set of chat messages for the LLM.
 *
 * @param stagedDiff   The output of `getStagedDiff()`.
 * @param retrieved    Top-k similar commits from `retrieve()`. May be empty
 *                     (cold-start repo).
 * @param options      Tuning knobs for truncation and example count.
 * @returns            Array of chat messages ready to send to an OpenAI-compatible API.
 */
export function buildPrompt(
  stagedDiff: string,
  retrieved: RetrieveResult[],
  options: PromptOptions = {},
): ChatMessage[] {
  const maxCurrentDiffLines = options.maxCurrentDiffLines ?? 300;
  const maxExampleDiffChars = options.maxExampleDiffChars ?? 1500;
  const maxExamples = options.maxExamples ?? 5;

  // ---- System message ----
  const language = options.language ?? "auto";
  const languageRule = language === "zh"
    ? "Write commit messages in Chinese (中文). Use Chinese for the subject line and body."
    : language === "en"
    ? "Write commit messages in English."
    : "Match the language of this project's existing commits. If the project uses English, write in English; if Chinese, write in Chinese; if mixed, follow the dominant pattern.";

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT.replace("{{LANGUAGE_RULE}}", languageRule) },
  ];

  // ---- User message ----
  let userContent = "";

  // Few-shot section
  const examples = retrieved.slice(0, maxExamples);

  if (examples.length > 0) {
    userContent += "## Historical commits (similar changes from this repository)\n\n";

    for (let i = 0; i < examples.length; i++) {
      const { entry, score } = examples[i];
      const truncatedDiff = truncateExampleDiff(
        entry.diffSummary,
        maxExampleDiffChars,
      );

      userContent += `### Example ${i + 1} (similarity: ${score.toFixed(2)})\n\n`;
      userContent += `**Commit:** \`${entry.hash.slice(0, 7)}\` ${entry.message}\n\n`;
      userContent += `<diff>\n${truncatedDiff}\n</diff>\n\n`;
      userContent += "---\n\n";
    }

    userContent +=
      "The examples above show this project's commit conventions. ";
    userContent +=
      "Use the same type names, scopes, language, and formatting style.\n\n";
  } else {
    // Cold-start fallback (§6 risk 2)
    userContent +=
      "## Note: no historical commit examples available\n\n";
    userContent +=
      "This appears to be a new repository with no indexed commit history. ";
    userContent +=
      "Use standard Conventional Commits conventions. ";
    userContent +=
      "Common types: feat, fix, chore, docs, style, refactor, perf, test.\n\n";
  }

  // Current diff section
  const diffText = stagedDiff.trim()
    ? truncateCurrentDiff(stagedDiff, maxCurrentDiffLines)
    : "(no staged changes — the staging area is empty)";

  userContent += "## Current staged changes\n\n";
  userContent += "```diff\n" + diffText + "\n```\n\n";
  userContent += "Generate a single commit message for these staged changes.";

  messages.push({ role: "user", content: userContent });

  return messages;
}

// ---------------------------------------------------------------------------
// Token estimation (approximate)
// ---------------------------------------------------------------------------

/**
 * Rough token count estimator. Not exact — uses the common heuristic of
 * ~4 characters per token for English text. Good enough for budget warnings.
 *
 * For precise counting, use a proper tokenizer (e.g. tiktoken), but that
 * adds a heavy dependency for marginal benefit at MVP scale.
 */
export function estimateTokens(text: string): number {
  // GPT/Claude tokenizer heuristic: ~4 chars per token for English,
  // ~2 chars per token for CJK. We use 3.5 as a middle ground since
  // commit messages and diffs are often a mix.
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate the total token count for a set of chat messages.
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Each message has ~4 tokens of overhead (role marker, formatting)
    total += 4 + estimateTokens(msg.content);
  }
  return total;
}
