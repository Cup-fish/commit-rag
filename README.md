# commit-rag

> AI-powered commit message generator that **learns from your repository's own
> commit history** via Retrieval-Augmented Generation (RAG).

[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-blue?logo=visual-studio-code)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/Node-18%2B-green?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-3178c6?logo=typescript)](https://www.typescriptlang.org/)

Instead of generating generic commit messages from a static prompt, commit-rag
indexes your repo's commit history, retrieves the most similar past commits to
your current change, and uses them as few-shot examples — so the generated
message matches **your project's conventions**, not generic best practices.

![Screenshot of commit-rag in VS Code](./docs/assets/screenshot.png)

---

## Why RAG?

A naive "write a commit message for this diff" prompt gives you a reasonable
but **generic** message. It doesn't know that your project uses `feat(core):`
with a specific scope convention, or that bug fixes are always `fix:` with a
certain phrasing pattern.

**commit-rag** indexes your last 200 commits, embeds their diffs into a vector
space, and retrieves the most similar ones when you stage new changes. The LLM
sees those real examples and copies your project's style.

This is the same insight that makes RAG valuable for documentation Q&A and code
search — but applied to the commit message problem.

---

## Architecture

```
┌──────────────────────────────────┐
│       @commit-rag/core           │  ← IDE-independent engine (TypeScript)
│  git · diff · embedding · index  │
│  retrieve · prompt · llm · config│
└────────────┬─────────────────────┘
             │
  ┌──────────▼──────────┐
  │  VS Code Extension   │  ← Phase 1 (this repo)
  │  SCM button · Secret │
  │  Storage · progress  │
  └──────────────────────┘
```

The core engine has **no VS Code dependency** — it's a plain TypeScript library.
The VS Code extension is a thin UI layer that imports it. This means the same
engine can be used for a JetBrains plugin, a CLI tool, or a GitHub Action.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design rationale.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [pnpm](https://pnpm.io/) ≥ 8
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) (for LLM generation)
- An [Alibaba Cloud DashScope API key](https://dashscope.console.aliyun.com/apiKey) (for embedding)

### Install & Build

```bash
git clone <this-repo>
cd commit-rag
pnpm install
pnpm build
```

### VS Code Extension

1. Open `packages/vscode-extension` in VS Code
2. Press **F5** → Extension Development Host
3. Open any git repository
4. Stage some changes (`git add`)
5. Click the ✨ (sparkle) button in the SCM title bar
6. Review the generated message → click **Commit**

Or package it for distribution:

```bash
cd packages/vscode-extension
pnpm package    # produces commit-rag-vscode-0.0.0.vsix
```

### CLI / Core Library

```typescript
import {
  getStagedDiff,
  QwenEmbeddingProvider,
  buildIndex,
  saveIndex,
  loadIndex,
  retrieve,
  buildPrompt,
  generateCommitMessage,
} from "@commit-rag/core";

// 1. Build the RAG index (once per repo)
const embedder = new QwenEmbeddingProvider({ apiKey: "sk-..." });
const index = await buildIndex(embedder, config, { cwd: "/path/to/repo" });
saveIndex(index, "/path/to/repo");

// 2. Generate a commit message
const diff = await getStagedDiff({ cwd: "/path/to/repo" });
const [queryVec] = await embedder.embed([diff]);
const similar = retrieve(queryVec, index, 5);
const messages = buildPrompt(diff, similar);
const result = await generateCommitMessage(messages, { apiKey: "sk-..." });

console.log(result.message);
// → "feat(auth): add JWT middleware with role-based access control"
```

---

## Project Structure

```
commit-rag/
├── packages/
│   ├── core/                     # @commit-rag/core
│   │   └── src/
│   │       ├── git.ts            # Git interface (execFile, not exec)
│   │       ├── embedding.ts      # EmbeddingProvider + Qwen/DashScope
│   │       ├── diff.ts           # Shared diff parsing utilities
│   │       ├── indexer.ts        # Indexing pipeline
│   │       ├── retrieve.ts       # Cosine similarity retrieval
│   │       ├── prompt.ts         # System + few-shot prompt construction
│   │       ├── llm.ts            # DeepSeek API (OpenAI-compatible)
│   │       ├── config.ts         # Layered config (defaults → rc → env)
│   │       └── index.ts          # Public barrel export
│   └── vscode-extension/         # VS Code extension
│       └── src/
│           └── extension.ts      # SCM button, SecretStorage, progress
├── scripts/                      # Day-by-day smoke tests
│   ├── smoke-test.mjs            # Day 1: git
│   ├── smoke-test-day2.mjs       # Day 2: embedding + index + retrieve
│   ├── smoke-test-day3.mjs       # Day 3: prompt (22 unit tests)
│   ├── smoke-test-day4.mjs       # Day 4: LLM + error handling
│   └── smoke-test-day5.mjs       # Day 5-6: extension + pipeline
├── docs/
│   ├── design.md                 # Original design document
│   └── progress.md               # Day-by-day progress journal
├── tsconfig.base.json
├── pnpm-workspace.yaml
└── package.json
```

---

## Configuration

### API Keys

API keys are **never** stored in files. They are loaded from:

1. **VS Code SecretStorage** (the extension) — stored in your OS keychain
2. **Environment variables** (CLI usage):
   - `COMMIT_RAG_DASHSCOPE_API_KEY` — DashScope / Qwen embedding
   - `COMMIT_RAG_DEEPSEEK_API_KEY` — DeepSeek LLM

### Repository Settings

Create a `.commitragrc.json` in your repo root (all fields optional):

```json
{
  "indexing": {
    "maxCommits": 200,
    "maxDiffLines": 500
  },
  "retrieval": {
    "topK": 5
  },
  "model": {
    "embeddingModel": "text-embedding-v4",
    "embeddingDimensions": 1024,
    "llmModel": "deepseek-chat"
  }
}
```

---

## Development

```bash
pnpm install          # Install all workspace dependencies
pnpm build            # Build all packages
pnpm --filter @commit-rag/core build    # Build only core
pnpm --filter commit-rag-vscode build   # Build only extension
```

Run the smoke tests:

```bash
# Day 1: git interface
node scripts/smoke-test.mjs

# Day 2: embedding + index + retrieve
COMMIT_RAG_DASHSCOPE_API_KEY=sk-... node scripts/smoke-test-day2.mjs

# Day 3: prompt construction (no API key needed)
node scripts/smoke-test-day3.mjs

# Day 4: LLM + error handling
COMMIT_RAG_DEEPSEEK_API_KEY=sk-... node scripts/smoke-test-day4.mjs

# Day 5-6: extension verification + full pipeline
COMMIT_RAG_DASHSCOPE_API_KEY=sk-... COMMIT_RAG_DEEPSEEK_API_KEY=sk-... \
  node scripts/smoke-test-day5.mjs
```

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Embedding | Qwen text-embedding-v4 (DashScope) | 100+ languages, ¥0.0005/1K tokens, OpenAI-compatible |
| LLM | DeepSeek (deepseek-chat) | Strong code understanding, OpenAI-compatible, affordable |
| Vector search | Brute-force cosine similarity | < 1000 entries, < 1ms per query |
| VS Code integration | Extension API + Git API | Native SCM button, SecretStorage, withProgress |
| Build | pnpm workspace + TypeScript 5.5 | Monorepo, strict mode, ES2022 target |

---

## License

MIT
