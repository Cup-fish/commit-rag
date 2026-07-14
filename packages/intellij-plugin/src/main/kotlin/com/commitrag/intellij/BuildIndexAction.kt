package com.commitrag.intellij

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware

/**
 * Builds (or rebuilds) the RAG index for the current project.
 *
 * Calls `commit-rag-cli index --repo <project-path>` in a background task.
 * The index is stored at `.commit-rag/index.json` in the repo root and
 * shared between the VS Code and JetBrains plugins.
 *
 * Available from:
 * - Tools menu (always visible when a project is open)
 * - VCS commit dialog (visible when commit panel is open, via Vcs.MessageActionGroup)
 */
class BuildIndexAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        // Show in both Tools menu (always when project is open) and commit dialog
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = service<CommitRagSettings>()
        val repoPath = project.basePath ?: return

        // Pre-check: Node.js
        val nodeCheck = CommitRagService.checkNode()
        if (!nodeCheck.available) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("com.commitrag.notifications")
                .createNotification(
                    "commit-rag: Node.js not available",
                    nodeCheck.error
                        ?: "Node.js is required to build the RAG index.\n\n" +
                            "Configure the Node.js path in Settings > Tools > commit-rag.",
                    NotificationType.ERROR,
                )
                .notify(project)
            return
        }

        // Pre-check: API keys
        val hasDashscope = settings.getDashscopeKey() != null
        if (!hasDashscope) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("com.commitrag.notifications")
                .createNotification(
                    "commit-rag: DashScope API key required",
                    "A DashScope API key is needed to build the embedding index.\n\n" +
                        "Configure it via:\n" +
                        "1. Environment variable: COMMIT_RAG_DASHSCOPE_API_KEY\n" +
                        "2. Settings > Tools > commit-rag (stored in OS keychain)",
                    NotificationType.WARNING,
                )
                .notify(project)
            return
        }

        // Run in background
        ProgressManager.getInstance().run(object : Task.Backgroundable(
            project,
            "commit-rag: building RAG index...",
            /* canBeCancelled = */ true,
        ) {
            override fun run(indicator: ProgressIndicator) {
                indicator.text = "Fetching commit history..."
                indicator.fraction = 0.1

                try {
                    val result = CommitRagService.buildIndex(
                        repoPath = repoPath,
                        cliPath = settings.cliPath,
                        nodePath = settings.nodePath,
                    )

                    indicator.fraction = 0.9
                    indicator.text = "Index saved..."

                    ApplicationManager.getApplication().invokeLater {
                        NotificationGroupManager.getInstance()
                            .getNotificationGroup("com.commitrag.notifications")
                            .createNotification(
                                "RAG index built",
                                "Indexed ${result.indexedCommits} commits.\n" +
                                    "Index path: ${result.indexPath}\n\n" +
                                    "The index is shared between IDEs — VS Code and " +
                                    "JetBrains plugins read the same file.",
                                NotificationType.INFORMATION,
                            )
                            .notify(project)
                    }

                    indicator.fraction = 1.0
                } catch (ex: CommitRagException) {
                    ApplicationManager.getApplication().invokeLater {
                        NotificationGroupManager.getInstance()
                            .getNotificationGroup("com.commitrag.notifications")
                            .createNotification(
                                "commit-rag: index build failed",
                                "[${ex.errorCode}] ${ex.message}",
                                NotificationType.ERROR,
                            )
                            .notify(project)
                    }
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        NotificationGroupManager.getInstance()
                            .getNotificationGroup("com.commitrag.notifications")
                            .createNotification(
                                "commit-rag: index build failed",
                                "Unexpected error: ${ex.message}",
                                NotificationType.ERROR,
                            )
                            .notify(project)
                    }
                }
            }
        })
    }
}
