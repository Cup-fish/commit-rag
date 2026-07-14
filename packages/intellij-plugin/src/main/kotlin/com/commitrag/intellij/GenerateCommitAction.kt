package com.commitrag.intellij

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.CheckinProjectPanel
import com.intellij.openapi.vcs.VcsDataKeys

/**
 * Action that appears as a button in the VCS commit dialog ("Generate Commit (RAG)").
 *
 * On first use, prompts the user to configure API keys (PasswordSafe or env vars).
 * On subsequent uses, calls the CLI and sets the commit message.
 *
 * Hook point: registered in [Vcs.MessageActionGroup] via plugin.xml.
 */
class GenerateCommitAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val panel = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER)
        val project = e.project

        // Only show this button when the commit dialog is open
        e.presentation.isEnabledAndVisible =
            panel != null && project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val panel = getCheckinPanel(e) ?: return
        val settings = service<CommitRagSettings>()
        val repoPath = project.basePath ?: return

        // Quick pre-check: is Node.js available?
        val nodeCheck = CommitRagService.checkNode()
        if (!nodeCheck.available) {
            showNodeError(project, nodeCheck.error ?: "Node.js not available")
            return
        }

        // First-use check: are API keys configured anywhere?
        if (!settings.hasBothKeysConfigured()) {
            showFirstUsePrompt(project)
            return
        }

        // Run the CLI in a background task (may take 3-10 seconds)
        ProgressManager.getInstance().run(object : Task.Backgroundable(
            project,
            "commit-rag: generating commit message...",
            /* canBeCancelled = */ true,
        ) {
            override fun run(indicator: ProgressIndicator) {
                indicator.text = "Retrieving similar commits from RAG index..."
                indicator.fraction = 0.3

                try {
                    val result = CommitRagService.generate(
                        repoPath = repoPath,
                        cliPath = settings.cliPath,
                        nodePath = settings.nodePath,
                    )

                    indicator.fraction = 0.9
                    indicator.text = "Setting commit message..."

                    // Set the commit message on the EDT (UI thread)
                    ApplicationManager.getApplication().invokeLater {
                        panel.setCommitMessage(result.message)
                        showSuccessNotification(project, result)
                    }

                    indicator.fraction = 1.0
                } catch (ex: CommitRagException) {
                    ApplicationManager.getApplication().invokeLater {
                        showCliError(project, ex)
                    }
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        showCliError(project,
                            CommitRagException(
                                "Unexpected error: ${ex.message}",
                                "UNEXPECTED",
                            )
                        )
                    }
                }
            }
        })
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Extract the [CheckinProjectPanel] from the action event.
     */
    private fun getCheckinPanel(e: AnActionEvent): CheckinProjectPanel? {
        val handler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER) ?: return null
        return if (handler is CheckinProjectPanel) handler else null
    }

    /**
     * Show a first-use prompt when no API keys are configured.
     * Offers to open Settings > Tools > commit-rag so the user can enter
     * their keys into PasswordSafe.
     */
    private fun showFirstUsePrompt(project: Project) {
        val settings = service<CommitRagSettings>()
        val hasDashscope = settings.getDashscopeKey() != null
        val hasDeepseek = settings.getDeepseekKey() != null

        val missingKeys = buildString {
            if (!hasDashscope) append("\n  - DashScope API key (Qwen embedding)")
            if (!hasDeepseek) append("\n  - DeepSeek API key (LLM generation)")
        }

        val note = NotificationGroupManager.getInstance()
            .getNotificationGroup("com.commitrag.notifications")
            .createNotification(
                "commit-rag: API keys not configured",
                "The following API keys are required but not set:$missingKeys\n\n" +
                    "Keys can be configured via:\n" +
                    "1. Environment variables: COMMIT_RAG_DASHSCOPE_API_KEY / COMMIT_RAG_DEEPSEEK_API_KEY\n" +
                    "2. Plugin settings (stored in your OS keychain via PasswordSafe)\n\n" +
                    "Click 'Configure Keys' below to open the settings page.",
                NotificationType.WARNING,
            )

        note.addAction(
            com.intellij.notification.NotificationAction.createSimple(
                "Configure Keys"
            ) {
                ShowSettingsUtil.getInstance().showSettingsDialog(
                    project,
                    "com.commitrag.intellij.settings"
                )
                note.expire()
            }
        )
        note.notify(project)
    }

    private fun showNodeError(project: Project, error: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("com.commitrag.notifications")
            .createNotification(
                "commit-rag: Node.js not available",
                "Please install Node.js 18 or newer.\n\n$error\n\n" +
                    "Configure the Node.js path in Settings > Tools > commit-rag.",
                NotificationType.ERROR,
            )
            .notify(project)
    }

    private fun showCliError(project: Project, ex: CommitRagException) {
        val title = when (ex.errorCode) {
            "MISSING_DASHSCOPE_KEY" -> "DashScope API key not configured"
            "MISSING_DEEPSEEK_KEY" -> "DeepSeek API key not configured"
            "NO_STAGED_CHANGES" -> "No staged changes"
            "NO_INDEX" -> "RAG index not found"
            "GIT_ERROR" -> "Git error"
            "CLI_PARSE_ERROR" -> "CLI output parse error"
            else -> "commit-rag error"
        }

        val actionHint = when (ex.errorCode) {
            "NO_INDEX" ->
                "\n\nRun 'commit-rag-cli index' first, or click 'Build Index' below."
            "MISSING_DASHSCOPE_KEY", "MISSING_DEEPSEEK_KEY" ->
                "\n\nSet the required API key. Environment variables take precedence " +
                    "over PasswordSafe."
            else -> ""
        }

        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("com.commitrag.notifications")
            .createNotification(
                title,
                ex.message + actionHint,
                NotificationType.ERROR,
            )

        // For key-related and index errors, add a shortcut to open settings
        if (ex.errorCode in listOf("MISSING_DASHSCOPE_KEY", "MISSING_DEEPSEEK_KEY", "NO_INDEX")) {
            notification.addAction(
                com.intellij.notification.NotificationAction.createSimple("Configure Keys") {
                    ShowSettingsUtil.getInstance().showSettingsDialog(
                        project,
                        "com.commitrag.intellij.settings"
                    )
                    notification.expire()
                }
            )
        }

        notification.notify(project)
    }

    private fun showSuccessNotification(project: Project, result: CommitRagService.GenerateResult) {
        val similarInfo = if (result.topScores.isNotEmpty()) {
            val top = result.topScores.first()
            " (matched: ${top.hash} \"${top.message.take(50)}\", score=${"%.2f".format(top.score)})"
        } else {
            ""
        }

        NotificationGroupManager.getInstance()
            .getNotificationGroup("com.commitrag.notifications")
            .createNotification(
                "Commit message generated",
                "Retrieved ${result.retrievedCount} similar commits$similarInfo. " +
                    "Review the message before committing.",
                NotificationType.INFORMATION,
            )
            .notify(project)
    }
}
