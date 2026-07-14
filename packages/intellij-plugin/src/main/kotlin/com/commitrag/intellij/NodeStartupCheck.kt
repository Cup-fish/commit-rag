package com.commitrag.intellij

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Runs when a project is opened. Checks whether Node.js is available
 * and shows a one-time warning if not.
 *
 * Design doc §5.4: the plugin must detect Node availability at startup
 * and give a clear error, not silently fail.
 */
class NodeStartupCheck : ProjectActivity {

    override suspend fun execute(project: Project) {
        val check = CommitRagService.checkNode()
        if (!check.available) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("com.commitrag.notifications")
                .createNotification(
                    "commit-rag: Node.js not found",
                    check.error + "\n\n" +
                        "The commit-rag plugin requires Node.js ≥ 18 to run the CLI. " +
                        "Install Node.js from https://nodejs.org/ and configure the path " +
                        "in Settings > Tools > commit-rag.",
                    NotificationType.WARNING,
                )
                .notify(project)
        }
    }
}
