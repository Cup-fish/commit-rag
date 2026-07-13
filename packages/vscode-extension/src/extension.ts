/**
 * commit-rag VS Code extension.
 *
 * Provides an AI-powered commit message generator that learns from the
 * repository's own commit history via RAG (Retrieval-Augmented Generation).
 *
 * Architecture (design doc §4):
 * - SCM title-bar button triggers generation
 * - Generated message fills the commit input box — user reviews before committing
 * - API keys stored in VS Code SecretStorage (never in settings.json)
 * - Indexing progress shown via vscode.window.withProgress
 * - Status bar shows index state
 *
 * Phase 1, Day 5–6 implementation.
 */

import * as vscode from "vscode";
import {
  // Git
  getStagedDiff,
  getCommitHistory,
  // Embedding
  QwenEmbeddingProvider,
  // Indexer
  buildIndex,
  saveIndex,
  loadIndex,
  // Retrieval
  retrieve,
  // Prompt
  buildPrompt,
  // LLM
  generateCommitMessage,
} from "@commit-rag/core";

// ---------------------------------------------------------------------------
// SecretStorage keys
// ---------------------------------------------------------------------------

const SECRET_KEY_DASHSCOPE = "commit-rag.dashscopeApiKey";
const SECRET_KEY_DEEPSEEK = "commit-rag.deepseekApiKey";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the workspace root directory.
 * Returns `undefined` if no workspace is open.
 */
function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

/**
 * Access the built-in Git extension's repository API.
 * Returns the first repository, or `undefined` if git isn't available.
 */
function getGitRepo(): {
  inputBox: { value: string };
  rootUri: { fsPath: string };
} | undefined {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    if (!ext || !ext.isActive) return undefined;
    const git = ext.exports.getAPI(1);
    return git.repositories[0] as
      | { inputBox: { value: string }; rootUri: { fsPath: string } }
      | undefined;
  } catch {
    return undefined;
  }
}

/** Read an API key from SecretStorage. */
async function getSecret(
  secrets: vscode.SecretStorage,
  key: string,
): Promise<string | undefined> {
  try {
    return await secrets.get(key);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Key configuration flow
// ---------------------------------------------------------------------------

/**
 * Prompt the user to configure API keys if they're missing.
 * Returns `true` if both keys are now available.
 */
async function ensureKeys(
  secrets: vscode.SecretStorage,
): Promise<{ dashscope?: string; deepseek?: string }> {
  let dashscope = await getSecret(secrets, SECRET_KEY_DASHSCOPE);
  let deepseek = await getSecret(secrets, SECRET_KEY_DEEPSEEK);

  const missing: string[] = [];
  if (!dashscope) missing.push("DashScope (Qwen embedding)");
  if (!deepseek) missing.push("DeepSeek (LLM generation)");

  if (missing.length > 0) {
    const configure = await vscode.window.showWarningMessage(
      `commit-rag: API keys not configured for:\n${missing.map((m) => `  • ${m}`).join("\n")}\n\nConfigure now?`,
      { modal: true },
      "Configure Keys",
    );

    if (configure === "Configure Keys") {
      await configureKeysCommand(secrets);
      dashscope = await getSecret(secrets, SECRET_KEY_DASHSCOPE);
      deepseek = await getSecret(secrets, SECRET_KEY_DEEPSEEK);
    }
  }

  return { dashscope, deepseek };
}

/**
 * The "Configure API Keys" command implementation.
 * Opens input boxes for both keys (masked).
 */
async function configureKeysCommand(
  secrets: vscode.SecretStorage,
): Promise<void> {
  const currentDashscope = await getSecret(secrets, SECRET_KEY_DASHSCOPE);
  const currentDeepseek = await getSecret(secrets, SECRET_KEY_DEEPSEEK);

  // DashScope key
  const dashscope = await vscode.window.showInputBox({
    title: "commit-rag: DashScope API Key (Qwen embedding)",
    prompt:
      "Enter your Alibaba Cloud DashScope API key. Get one at: https://dashscope.console.aliyun.com/apiKey",
    password: true,
    value: currentDashscope ?? "",
    placeHolder: "sk-...",
    ignoreFocusOut: true,
  });
  if (dashscope !== undefined) {
    // User pressed OK (even if empty — we store what they give us)
    if (dashscope.trim()) {
      await secrets.store(SECRET_KEY_DASHSCOPE, dashscope.trim());
    } else {
      await secrets.delete(SECRET_KEY_DASHSCOPE);
    }
  }
  // If user pressed Escape, dashscope is undefined — don't change stored value

  // DeepSeek key
  const deepseek = await vscode.window.showInputBox({
    title: "commit-rag: DeepSeek API Key (LLM generation)",
    prompt:
      "Enter your DeepSeek API key. Get one at: https://platform.deepseek.com/api_keys",
    password: true,
    value: currentDeepseek ?? "",
    placeHolder: "sk-...",
    ignoreFocusOut: true,
  });
  if (deepseek !== undefined) {
    if (deepseek.trim()) {
      await secrets.store(SECRET_KEY_DEEPSEEK, deepseek.trim());
    } else {
      await secrets.delete(SECRET_KEY_DEEPSEEK);
    }
  }
}

// ---------------------------------------------------------------------------
// Indexing flow
// ---------------------------------------------------------------------------

/**
 * Build (or rebuild) the RAG index with progress reporting.
 */
async function doIndex(
  dashscopeKey: string,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage(
      "commit-rag: No workspace folder is open. Please open a git repository.",
    );
    return;
  }

  const existing = loadIndex(root);
  const commitCount = (await getCommitHistory(200, { cwd: root })).length;

  const doRebuild = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "commit-rag: Building commit index...",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: "Fetching commit history..." });

      const qwen = new QwenEmbeddingProvider({
        apiKey: dashscopeKey,
        dimensions: 1024,
      });

      const limit = Math.min(200, commitCount);

      const entries = await buildIndex(
        qwen,
        {
          indexing: { maxCommits: limit, maxDiffLines: 500 },
          retrieval: { topK: 5 },
          model: {
            embeddingModel: "text-embedding-v4",
            embeddingDimensions: 1024,
            llmModel: "deepseek-chat",
          },
          apiKeys: { dashscope: dashscopeKey },
        },
        {
          cwd: root,
          limit,
          onProgress: (current, total, hash) => {
            if (token.isCancellationRequested) return;
            progress.report({
              message: `${current}/${total} commits (${hash.slice(0, 7)})`,
              increment: (1 / total) * 100,
            });
          },
        },
      );

      if (token.isCancellationRequested) {
        void vscode.window.showWarningMessage(
          `commit-rag: Indexing cancelled. Indexed ${existing?.length ?? 0} commits (partial).`,
        );
        return false;
      }

      saveIndex(entries, root);
      return true;
    },
  );

  if (doRebuild) {
    const idx = loadIndex(root);
    updateStatusBar(statusBar, idx?.length ?? 0);
    void vscode.window.showInformationMessage(
      `commit-rag: Indexed ${idx?.length ?? 0} commits.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generate flow
// ---------------------------------------------------------------------------

/**
 * The full generation pipeline:
 *   staged diff → embedding → retrieve → prompt → DeepSeek → fill SCM input
 */
async function doGenerate(
  dashscopeKey: string,
  deepseekKey: string,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage(
      "commit-rag: No workspace folder is open.",
    );
    return;
  }

  // 1. Get staged diff
  let diff: string;
  try {
    diff = await getStagedDiff({ cwd: root });
  } catch {
    void vscode.window.showErrorMessage(
      "commit-rag: Failed to read staged changes. Are you in a git repository?",
    );
    return;
  }

  if (!diff.trim()) {
    void vscode.window.showWarningMessage(
      'commit-rag: No staged changes. Stage files with "git add" first.',
    );
    return;
  }

  // 2. Load or build index
  let index = loadIndex(root);
  if (!index || index.length === 0) {
    const build = await vscode.window.showInformationMessage(
      "commit-rag: No commit index found for this repository. Build it now?",
      { modal: true },
      "Build Index",
    );
    if (build === "Build Index") {
      await doIndex(dashscopeKey, statusBar);
      index = loadIndex(root);
    }
    if (!index || index.length === 0) {
      // proceed without index (cold-start)
      index = [];
    }
  }

  // 3. Run generation with progress
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "commit-rag: Generating commit message...",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Embedding staged diff..." });

      const qwen = new QwenEmbeddingProvider({
        apiKey: dashscopeKey,
        dimensions: 1024,
      });

      // Embed the staged diff
      const [queryVec] = await qwen.embed([diff]);

      // Retrieve similar commits
      progress.report({ message: "Retrieving similar commits..." });
      const retrieved = index.length > 0 ? retrieve(queryVec, index, 5) : [];

      // Build prompt
      progress.report({ message: "Calling DeepSeek..." });
      const messages = buildPrompt(diff, retrieved);

      // Generate
      return generateCommitMessage(messages, {
        apiKey: deepseekKey,
        model: "deepseek-chat",
        temperature: 0.3,
        maxTokens: 500,
      });
    },
  );

  // 4. Fill the SCM input box
  const gitRepo = getGitRepo();
  if (gitRepo) {
    gitRepo.inputBox.value = result.message;
    void vscode.window.showInformationMessage(
      `commit-rag: Commit message generated${
        result.usage
          ? ` (${result.usage.totalTokens} tokens)`
          : ""
      }. Review and press Commit.`,
    );
  } else {
    // Fallback: show message in a dialog if git API isn't available
    const action = await vscode.window.showInformationMessage(
      `commit-rag: Generated message:\n\n${result.message}`,
      { modal: true },
      "Copy to Clipboard",
    );
    if (action === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(result.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  indexedCount?: number,
): void {
  if (indexedCount === undefined || indexedCount === 0) {
    statusBar.text = "$(git-commit) commit-rag: not indexed";
    statusBar.tooltip =
      "commit-rag: RAG index not built yet. Click to build, or use the SCM sparkle button.";
    statusBar.command = "commit-rag.reindex";
  } else {
    statusBar.text = `$(database) commit-rag: ${indexedCount} commits indexed`;
    statusBar.tooltip = `commit-rag: ${indexedCount} historical commits indexed. Click to rebuild.`;
    statusBar.command = "commit-rag.reindex";
  }
}

// ---------------------------------------------------------------------------
// Activation / Deactivation
// ---------------------------------------------------------------------------

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("[commit-rag] extension activating...");

  const secrets = context.secrets;

  // ---- Status bar ----
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.name = "commit-rag";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Check existing index on startup
  const root = getWorkspaceRoot();
  if (root) {
    const existing = loadIndex(root);
    updateStatusBar(statusBar, existing?.length ?? 0);
  } else {
    updateStatusBar(statusBar, 0);
  }

  // ---- Commands ----

  // Generate commit message (also the SCM button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-rag.generateMessage",
      async () => {
        const keys = await ensureKeys(secrets);
        if (!keys.dashscope || !keys.deepseek) {
          void vscode.window.showWarningMessage(
            "commit-rag: Both API keys are required. Run 'Configure API Keys' first.",
          );
          return;
        }
        await doGenerate(keys.dashscope, keys.deepseek, statusBar);
      },
    ),
  );

  // Rebuild index
  context.subscriptions.push(
    vscode.commands.registerCommand("commit-rag.reindex", async () => {
      const keys = await ensureKeys(secrets);
      if (!keys.dashscope) {
        void vscode.window.showWarningMessage(
          "commit-rag: DashScope API key required for indexing. Run 'Configure API Keys' first.",
        );
        return;
      }
      await doIndex(keys.dashscope, statusBar);
    }),
  );

  // Configure API keys
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-rag.configureKeys",
      async () => {
        await configureKeysCommand(secrets);
        void vscode.window.showInformationMessage(
          "commit-rag: API keys updated.",
        );
      },
    ),
  );

  console.log("[commit-rag] extension activated");
}

export function deactivate(): void {
  console.log("[commit-rag] extension deactivated");
}
