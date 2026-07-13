/**
 * commit-rag VS Code extension — entry point.
 *
 * Phase 1, Day 1: skeleton only. The extension activates but does nothing
 * useful yet. Logic will be wired in on Day 5–6.
 */

import * as vscode from "vscode";
import { getStagedDiff, getCommitHistory } from "@commit-rag/core";

export function activate(context: vscode.ExtensionContext): void {
  // eslint-disable-next-line no-console
  console.log("commit-rag: extension activated");

  // Register the generate command (placeholder — Day 5-6 will implement)
  const disposable = vscode.commands.registerCommand(
    "commit-rag.generateMessage",
    async () => {
      // Smoke-test: verify the git layer works from inside the extension host
      const diff = await getStagedDiff();
      if (!diff.trim()) {
        void vscode.window.showWarningMessage(
          "No staged changes found. Stage some files (git add) and try again.",
        );
        return;
      }

      const history = await getCommitHistory(5);
      void vscode.window.showInformationMessage(
        `commit-rag: staged diff is ${diff.length} chars, ` +
          `found ${history.length} recent commits. ` +
          `(Full generation coming on Day 5–6)`,
      );
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // No cleanup needed yet
}
