import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class NotificationDispatcher: NSObject, UNUserNotificationCenterDelegate {
    private var popups: [UUID: PopupController] = [:]
    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }
    func requestPermissionIfNeeded(_ services: ServiceSettings, report: @escaping @MainActor (String?) -> Void) {
        let needed = [services.codex, services.claude].contains {
            $0.notifyMethod == .notification && ($0.notifyBelow != nil || $0.notifyEvery != nil || $0.notifyApiError)
        }
        guard needed else { return }
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                report(granted ? nil : "通知が許可されていません。システム設定の「通知」で TokenWatcher を許可してください。")
            } catch { report("通知の許可を確認できません。システム設定の「通知」を確認してください。") }
        }
    }
    func send(title: String, message: String, method: NotificationMethod, report: @escaping @MainActor (String?) -> Void) {
        if method == .popup {
            let identifier = UUID()
            let popup = PopupController(title: title, message: message) { [weak self] in self?.popups.removeValue(forKey: identifier) }
            popups[identifier] = popup
            popup.showWindow(nil)
            popup.window?.center()
            popup.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            Task {
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                    report("通知が許可されていません。システム設定の「通知」で TokenWatcher を許可してください。")
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = message
                content.sound = .default
                do { try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) }
                catch { report("通知を表示できませんでした。情報の取得は継続します。") }
            }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

@MainActor
private final class PopupController: NSWindowController, NSWindowDelegate {
    private let onClose: () -> Void
    init(title: String, message: String, onClose: @escaping () -> Void) {
        self.onClose = onClose
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 180),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = title
        panel.isReleasedWhenClosed = false
        super.init(window: panel)
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: VStack(alignment: .leading, spacing: 18) {
            Label(title, systemImage: "chart.bar.fill").font(.headline)
            Text(message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            HStack { Spacer(); Button("閉じる") { [weak self] in self?.close() }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 420))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) は未対応") }
    func windowWillClose(_ notification: Notification) { onClose() }
}
