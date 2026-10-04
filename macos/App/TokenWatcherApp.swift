import SwiftUI
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var showDashboard: (() -> Void)?
    private var pendingDashboard = false
    private var stopping = false
    private var readyToTerminate = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
            let icon = NSImage(contentsOf: iconURL) {
            // 起動中の Dock 表示を同梱アイコンに更新。
            NSApp.applicationIconImage = icon
            NSApp.dockTile.display()
        }
        AppModel.shared.start()
    }

    func registerDashboard(_ action: @escaping () -> Void) {
        showDashboard = action
        if pendingDashboard {
            pendingDashboard = false
            Task { @MainActor in action() }
        }
    }
    private func reopenDashboard() {
        if let showDashboard { showDashboard() }
        else { pendingDashboard = true }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard showDashboard != nil else {
            pendingDashboard = true
            return true
        }
        reopenDashboard()
        return false
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { $0.scheme == "tokenwatcher" && $0.host == "dashboard" }) {
            reopenDashboard()
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if readyToTerminate { return .terminateNow }
        guard !stopping else { return .terminateCancel }
        stopping = true
        // AppKit の終了待ちで MainActor の停止タスクを塞がない。
        Task {
            await AppModel.shared.stop()
            readyToTerminate = true
            sender.terminate(nil)
        }
        return .terminateCancel
    }
}
@main
struct TokenWatcherApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    @State private var menuBarVisible = AppModel.shared.settings.showMenuBarIcon
    var body: some Scene {
        Window("TokenWatcher", id: "main") {
            DashboardView(model: model, delegate: delegate)
                .frame(minWidth: 700, minHeight: 540)
                .task {
                    #if SCENE_CHECK
                    SceneChecks.start()
                    #endif
                }
        }.defaultSize(width: 780, height: 620)
            .onChange(of: model.settings.showMenuBarIcon) { _, visible in
                menuBarVisible = visible
            }
        Settings { SettingsView(model: model).frame(width: 660, height: 660) }
        Window("詳細ログ", id: "diagnostics") {
            DiagnosticLogView(model: model)
        }.defaultSize(width: 680, height: 560)
        // SwiftUI の表示状態と保存設定を分け、描画中には設定を書き戻さない。
        MenuBarExtra("TokenWatcher", systemImage: "chart.bar.fill",
            isInserted: $menuBarVisible) {
            MenuContent(model: model)
        }
    }
}
private struct MenuContent: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(model.status)
        Button("残量と詳細を開く") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("詳細ログを開く") { openWindow(id: "diagnostics"); NSApp.activate(ignoringOtherApps: true) }
        SettingsLink { Text("設定…") }
        Button("今すぐ更新") { model.refresh() }
        Divider()
        Button("終了") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
private struct DashboardView: View {
    @ObservedObject var model: AppModel
    let delegate: AppDelegate
    @Environment(\.openWindow) private var openWindow
    @State private var confirmLive = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("利用制限の残量").font(.largeTitle.bold())
                        Text(model.status).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { openWindow(id: "diagnostics") } label: { Label("詳細ログ", systemImage: "doc.text.magnifyingglass") }
                    SettingsLink { Label("設定", systemImage: "gearshape") }
                    Button { model.refresh() } label: { Label("更新", systemImage: "arrow.clockwise") }
                        .disabled(!model.running)
                }
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    UsageDashboard(snapshot: model.snapshot, now: context.date)
                        .padding(20).background(.background, in: RoundedRectangle(cornerRadius: 14))
                }
                if let error = model.storageError {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                if let error = model.notificationError {
                    Label(error, systemImage: "bell.slash").foregroundStyle(.orange)
                }
                HStack {
                    if !model.settings.hasStartedLiveData {
                        Text("初回は「情報取得を開始」から開始してください。次回起動から自動で取得します。")
                            .font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        Button("情報取得を開始") { confirmLive = true }.buttonStyle(.borderedProminent)
                    } else {
                        Text("ウィジェットの反映時刻は macOS が管理します。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                ForEach(model.snapshot.services) { state in
                    GroupBox(state.service.title + " の詳細") {
                        VStack(alignment: .leading, spacing: 10) {
                            if let error = state.lastError {
                                HStack(alignment: .top) {
                                    Text(error).foregroundStyle(.orange)
                                    Spacer()
                                    Button("詳細ログ") { openWindow(id: "diagnostics") }
                                }
                            }
                            if let usage = state.snapshot {
                                ForEach(usage.limits) { limit in
                                    HStack(alignment: .top) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("\(limit.title) / \(limit.window) / \(limit.period)").fontWeight(.medium)
                                            Text(limit.resetDate.map { "リセット \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "リセット日時不明")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text(String(format: "%.1f%%", limit.remainingPercent)).monospacedDigit()
                                    }
                                }
                                if let credits = usage.resetCredits {
                                    Text("リセットクレジット: 利用可能 \(credits.availableCount ?? credits.credits.filter { $0.status == "available" }.count)件")
                                    ForEach(Array(credits.credits.enumerated()), id: \.offset) { _, credit in
                                        Text("\(credit.title ?? credit.resetType ?? "不明") / \(credit.status ?? "不明") / 期限 \(credit.expiresAt.flatMap(usageDate)?.formatted(date: .abbreviated, time: .shortened) ?? "不明")")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            } else { Text("まだ取得していません。").foregroundStyle(.secondary) }
                        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text("CLI とアプリの通知設定は独立しています。両方で通知監視を動かすと、同じ内容が二重に通知される場合があります。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            delegate.registerDashboard {
                openWindow(id: "main")
                for window in NSApp.windows where window.title == "TokenWatcher" {
                    window.deminiaturize(nil)
                    window.makeKeyAndOrderFront(nil)
                }
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        .alert("実データの取得を開始", isPresented: $confirmLive) {
            Button("開始") { model.startLiveData() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("Codex の既存ログイン状態で利用量を取得します。Claude の auto / api はキーチェーンの OAuth トークンを読み、利用量 API に送信します。認証情報の表示・保存・更新は行いません。statusline は既存キャッシュだけを読みます。一度開始すると次回起動から自動で取得します。アプリを終了すると取得を停止します。")
        }
    }
}

private struct DiagnosticLogView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("詳細ログ").font(.title2.bold())
                Spacer()
                Button("コピー") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.diagnosticHistory.text, forType: .string)
                }.disabled(model.diagnosticHistory.entries.isEmpty)
                Button("閉じる") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text("アプリ起動中の直近100件を、新しい順に表示します。認証情報・API 応答の本文は含みません。終了するとログは消えます。")
                .font(.callout).foregroundStyle(.secondary)
            Text("自動取得の時刻は目安です。スリープや処理時間で遅れる場合があります。")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.diagnosticHistory.entries.isEmpty {
                        Text("まだログがありません。実データを取得すると、成功・失敗・待機の記録が表示されます。")
                            .foregroundStyle(.secondary).padding(.vertical, 24)
                    }
                    ForEach(Array(model.diagnosticHistory.entries.reversed())) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            Label(entry.detail.code.summary,
                                systemImage: entry.detail.code.isError ? "exclamationmark.triangle" : "info.circle")
                                .fontWeight(.medium)
                                .foregroundStyle(entry.detail.code.isError ? Color.orange : Color.primary)
                            Text(entry.text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(20).frame(minWidth: 580, minHeight: 360)
    }
}
