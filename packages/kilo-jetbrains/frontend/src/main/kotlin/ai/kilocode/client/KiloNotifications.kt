package ai.kilocode.client

import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager

object KiloNotifications {
    const val GROUP_ID = "Kilo Code"

    fun error(title: String, content: String? = null) {
        val project = ProjectManager.getInstance().openProjects.firstOrNull { !it.isDefault }
        error(project, title, content)
    }

    fun error(project: Project?, title: String, content: String? = null) {
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            ?.createNotification(title, content ?: "", NotificationType.ERROR)
            ?: Notification(GROUP_ID, title, content ?: "", NotificationType.ERROR)
        notification.notify(project)
    }
}
