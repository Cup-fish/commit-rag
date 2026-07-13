/**
 * @commit-rag/core
 *
 * IDE-independent core engine for the commit-rag project.
 * Currently exporting the git interface layer (Phase 1, Day 1).
 * Future modules: indexer, retrieve, prompt, llm, config.
 */

export { getStagedDiff, getCommitHistory, getCommitDiff } from "./git";
export type { CommitEntry, GitOptions } from "./git";
